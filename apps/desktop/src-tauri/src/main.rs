//! Single Guild client binary:
//! - no args  → GUI (Tauri window)
//! - `engine` → local engine loop (JSON-RPC over stdio; the GUI spawns this)
//! - `login` / `chat` / `publish` / `install` / `verify` → headless CLI
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use anyhow::Context as _;
use sha2::Digest as _;

#[cfg(all(windows, not(debug_assertions)))]
fn attach_parent_console() {
    // windows_subsystem="windows" detaches from the console; headless
    // subcommands re-attach so println! output is visible.
    const ATTACH_PARENT_PROCESS: u32 = 1;
    unsafe {
        windows_sys::Win32::System::Console::AttachConsole(ATTACH_PARENT_PROCESS);
    }
}

#[cfg(not(all(windows, not(debug_assertions))))]
fn attach_parent_console() {}

fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) != Some("gui") && !args.is_empty() {
        attach_parent_console();
    }
    match args.first().map(String::as_str) {
        None => {
            guild_desktop::run();
            Ok(())
        }
        // Engine mode: the GUI spawns itself with this argument; the JSON-RPC
        // stdio loop is the same one guild-app-server exposes.
        Some("engine") => {
            let rt = tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .enable_all()
                .build()?;
            let (_session, _writer) = rt.block_on(guild_app_server::jsonrpc_loop::serve(
                std::io::stdin(),
                std::io::stdout(),
                guild_app_server::jsonrpc_loop::Session::default(),
            ))?;
            Ok(())
        }
        Some("login") => cmd_login(&args[1..]),
        Some("chat") => cmd_chat(&args[1..]),
        Some("publish") => cmd_publish(&args[1..]),
        Some("install") => cmd_install(&args[1..]),
        Some("verify") => cmd_verify(&args[1..]),
        Some(other) => anyhow::bail!(
            "unknown subcommand {other:?}; expected none (GUI), engine, login, chat, publish, install, or verify"
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

fn cloud_from_session() -> anyhow::Result<guild_app_server::cloud::CloudClient> {
    let stored =
        guild_app_server::session_store::load(&guild_app_server::session_store::default_path()?)
            .context("not logged in — run `guild login` first")?;
    Ok(guild_app_server::cloud::CloudClient {
        base_url: stored.base_url,
        token: stored.token,
    })
}

fn cmd_login(args: &[String]) -> anyhow::Result<()> {
    let url = flag(args, "--url")?;
    let email = flag(args, "--email")?;
    let password = flag(args, "--password")?;
    let rt = tokio::runtime::Runtime::new()?;
    let (token, user) = rt.block_on(guild_app_server::cloud::CloudClient::login(
        &url, &email, &password,
    ))?;
    guild_app_server::session_store::save(
        &guild_app_server::session_store::default_path()?,
        &guild_app_server::session_store::StoredSession {
            base_url: url,
            token,
        },
    )?;
    println!("logged in as {}", user.email);
    Ok(())
}

fn cmd_chat(args: &[String]) -> anyhow::Result<()> {
    let text = args.last().context("missing prompt text")?.clone();
    let model = flag(args, "--model").unwrap_or_else(|_| "gpt-4o-mini".into());
    let cloud = cloud_from_session()?;
    let rt = tokio::runtime::Runtime::new()?;
    rt.block_on(async move {
        let chat_id = cloud.create_chat(Some("headless")).await?;
        let stream = cloud
            .chat_stream(chat_id, &model, &[protocol::api::Message::user(text)])
            .await?;
        let (reply, _done) = guild_app_server::cloud::collect_turn(stream).await?;
        println!("{reply}");
        Ok(())
    })
}

fn cmd_publish(args: &[String]) -> anyhow::Result<()> {
    let kind = flag(args, "--kind")?;
    let dir = flag(args, "--dir")?;
    let version = flag(args, "--version")?;
    let cloud = cloud_from_session()?;
    let rt = tokio::runtime::Runtime::new()?;
    let r = rt.block_on(guild_app_server::registry_client::publish(
        &cloud,
        &kind,
        std::path::Path::new(&dir),
        &version,
    ))?;
    println!("published {} {} {}", kind, r.slug, r.version);
    Ok(())
}

fn cmd_install(args: &[String]) -> anyhow::Result<()> {
    let slug = flag(args, "--slug")?;
    let project = flag(args, "--project").unwrap_or_else(|_| ".".into());
    let version = flag(args, "--version").ok();
    let cloud = cloud_from_session()?;
    let rt = tokio::runtime::Runtime::new()?;
    let entry = rt.block_on(guild_app_server::registry_client::install_skill(
        &cloud,
        std::path::Path::new(&project),
        &slug,
        version.as_deref(),
    ))?;
    println!("installed {} -> {}", entry.name, entry.path.display());
    Ok(())
}

/// `verify --file F --sig SIG --key PUBKEY`: offline ed25519 check that a
/// downloaded release artifact matches its published signature.
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
