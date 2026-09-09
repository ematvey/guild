//! guild-app-server — the local engine (spec §3.2).
//!
//! - No args: JSON-RPC loop on stdio (the desktop UI drives this).
//! - `login --url U --email E --password P`: headless login, persists token.
//! - `chat --model M "text"`: headless chat round-trip, prints the reply.

use anyhow::Context;
use guild_app_server::cloud::{collect_turn, CloudClient};
use guild_app_server::{jsonrpc_loop, session_store};
use protocol::api::Message;

fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        None => {
            let stdin = std::io::stdin().lock();
            let stdout = std::io::stdout().lock();
            let (session, _writer) =
                jsonrpc_loop::serve(stdin, stdout, jsonrpc_loop::Session::default())?;
            let _ = session;
            Ok(())
        }
        Some("login") => cmd_login(&args[1..]),
        Some("chat") => cmd_chat(&args[1..]),
        Some(other) => anyhow::bail!("unknown subcommand {other}; expected none, login, or chat"),
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
    session_store::save(
        &session_store::default_path()?,
        &session_store::StoredSession {
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
