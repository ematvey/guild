//! guild-app-server — the local engine (spec §3.2).
//!
//! - No args: JSON-RPC loop on stdio (dev/test surface; the shipped app
//!   uses the daemon).
//! - `daemon`: the per-user daemon — shared engine, survives client exit,
//!   the only session-token route to the cloud server.
//! - `login --url U --email E --password P`: headless login, persists token.
//! - `chat --model M "text"`: headless chat round-trip, prints the reply.

use anyhow::Context;
use guild_app_server::cloud::{collect_turn, CloudClient};
use guild_app_server::{jsonrpc_loop, session_store};
use protocol::api::Message;
use sha2::Digest as _;
use std::path::Path;

fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        None => {
            let rt = tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .enable_all()
                .build()?;
            // Restore a persisted session so a GUI reload (F5) or an app
            // restart keeps auth; a dead token is dropped, a transient
            // network failure is not.
            let session = rt.block_on(jsonrpc_loop::restored_session())?;
            let (session, _writer) = rt.block_on(jsonrpc_loop::serve(
                std::io::stdin(),  // Stdin handle: Read + Send + 'static
                std::io::stdout(), // Stdout handle: Write + Send + 'static
                session,
            ))?;
            let _ = session;
            Ok(())
        }
        Some("daemon") => {
            let rt = tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .enable_all()
                .build()?;
            rt.block_on(guild_app_server::daemon::run_daemon())?;
            Ok(())
        }
        Some("login") => cmd_login(&args[1..]),
        Some("chat") => cmd_chat(&args[1..]),
        Some("publish") => cmd_publish(&args[1..]),
        Some("install") => cmd_install(&args[1..]),
        Some("verify") => cmd_verify(&args[1..]),
        Some(other) => anyhow::bail!(
            "unknown subcommand {other}; expected none, daemon, login, chat, publish, install, or verify"
        ),
    }
}

fn flag(args: &[String], name: &str) -> anyhow::Result<String> {
    let pos = args
        .iter()
        .position(|a| a == name)
        .context(format!("missing {name}"))?;
    args.get(pos + 1)
        .cloned()
        .context(format!("{name} needs a value"))
}

fn cmd_login(args: &[String]) -> anyhow::Result<()> {
    let url = flag(args, "--url")?;
    let email = flag(args, "--email")?;
    let password = flag(args, "--password")?;
    let rt = tokio::runtime::Runtime::new()?;
    let (token, user) = rt.block_on(CloudClient::login(&url, &email, &password))?;
    let user_email = user.email.clone();
    session_store::save(
        &session_store::default_path()?,
        &session_store::StoredSession {
            base_url: url,
            token,
            email: Some(user.email),
        },
    )?;
    println!("logged in as {}", user_email);
    Ok(())
}

fn cmd_publish(args: &[String]) -> anyhow::Result<()> {
    let kind = flag(args, "--kind")?;
    let dir = flag(args, "--dir")?;
    let version = flag(args, "--version")?;
    let stored = session_store::load(&session_store::default_path()?)
        .context("not logged in — run `guild-app-server login` first")?;
    let rt = tokio::runtime::Runtime::new()?;
    rt.block_on(async move {
        let cloud = CloudClient {
            base_url: stored.base_url,
            token: stored.token,
        };
        let r =
            guild_app_server::registry_client::publish(&cloud, &kind, Path::new(&dir), &version)
                .await?;
        println!("published {} {} {}", kind, r.slug, r.version);
        Ok(())
    })
}

fn cmd_install(args: &[String]) -> anyhow::Result<()> {
    let slug = flag(args, "--slug")?;
    let version = flag(args, "--version").ok();
    let project = flag(args, "--project")?;
    let stored = session_store::load(&session_store::default_path()?)
        .context("not logged in — run `guild-app-server login` first")?;
    let rt = tokio::runtime::Runtime::new()?;
    rt.block_on(async move {
        let cloud = CloudClient {
            base_url: stored.base_url,
            token: stored.token,
        };
        let entry = guild_app_server::registry_client::install_skill(
            &cloud,
            Path::new(&project),
            &slug,
            version.as_deref(),
        )
        .await?;
        println!("installed {} -> {}", entry.name, entry.path.display());
        Ok(())
    })
}

/// `verify --file F --sig SIG --key PUBKEY`: offline ed25519 check that a
/// downloaded release artifact matches its published signature. The digest
/// signed is sha256(F); both sig and pubkey are hex.
fn cmd_verify(args: &[String]) -> anyhow::Result<()> {
    use ed25519_dalek::{Signature, Verifier, VerifyingKey};
    let file = flag(args, "--file")?;
    let sig_hex = flag(args, "--sig")?;
    let key_hex = flag(args, "--key")?;
    let bytes = std::fs::read(&file).context("cannot read artifact")?;
    let digest = sha2::Sha256::digest(&bytes);
    let vk_bytes: [u8; 32] = hex::decode(key_hex)
        .context("key is not hex")?
        .try_into()
        .map_err(|_| anyhow::anyhow!("key must be 32 bytes (64 hex chars)"))?;
    let vk = VerifyingKey::from_bytes(&vk_bytes)?;
    let sig_bytes: [u8; 64] = hex::decode(sig_hex)
        .context("sig is not hex")?
        .try_into()
        .map_err(|_| anyhow::anyhow!("sig must be 64 bytes (128 hex chars)"))?;
    vk.verify(&digest, &Signature::from_bytes(&sig_bytes))
        .context("signature does NOT match — artifact is not authentic")?;
    println!("OK: {} verified (sha256 {})", file, hex::encode(digest));
    Ok(())
}

fn cmd_chat(args: &[String]) -> anyhow::Result<()> {
    let text = args.last().context("missing prompt text")?.clone();
    let model = flag(args, "--model").unwrap_or_else(|_| "gpt-4o-mini".into());
    let stored = session_store::load(&session_store::default_path()?)
        .context("not logged in — run `guild-app-server login` first")?;
    let rt = tokio::runtime::Runtime::new()?;
    rt.block_on(async move {
        let client = CloudClient {
            base_url: stored.base_url,
            token: stored.token,
        };
        let chat_id = client.create_chat(Some("headless")).await?;
        let stream = client
            .chat_stream(chat_id, &model, &[Message::user(text)])
            .await?;
        let (reply, done) = collect_turn(stream).await?;
        println!("{reply}");
        if let Some(protocol::api::StreamEvent::Done {
            cost_usd,
            tokens_in,
            tokens_out,
            ..
        }) = done
        {
            eprintln!("cost ${cost_usd:.6} ({tokens_in} in / {tokens_out} out, chat {chat_id})");
        }
        Ok(())
    })
}
