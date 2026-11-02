//! Headless CLI verbs. Every cloud-touching verb reaches the engine's local
//! socket (hosted by the running desktop app or a headless `daemon`), so
//! the hosting engine owns the session; `chat` borrows that session and
//! streams from the gateway itself; `verify` stays offline. Shared by the
//! guild-app-server and Guild binaries.

use crate::cloud::{CloudClient, CloudError};
use crate::daemon_client::DaemonClient;
use anyhow::Context as _;
use protocol::api::{Message, StreamEvent};
use serde_json::json;
use std::path::PathBuf;

pub fn flag(args: &[String], name: &str) -> anyhow::Result<String> {
    let pos = args
        .iter()
        .position(|a| a == name)
        .context(format!("missing {name}"))?;
    args.get(pos + 1)
        .cloned()
        .context(format!("{name} needs a value"))
}

pub fn cmd_login(args: &[String]) -> anyhow::Result<()> {
    let mut client = DaemonClient::attach()?;
    let res = match flag(args, "--token").or_else(|_| flag(args, "--code")) {
        // Pairing code (web-issued `g1|<url>|<secret>`): the code carries the
        // server URL itself, so --url is not needed.
        Ok(code) => client.call("pair", json!({"code": code}))?,
        Err(_) => {
            let url = flag(args, "--url")?;
            let email = flag(args, "--email")?;
            let password = flag(args, "--password")?;
            client.call(
                "login",
                json!({"base_url": url, "email": email, "password": password}),
            )?
        }
    };
    // the daemon validates, stores the session and keeps it in memory
    println!(
        "logged in as {}",
        res["user"]["email"].as_str().unwrap_or("?")
    );
    Ok(())
}

/// `chat [--model M] "text"`: one plain (tool-less) turn in a fresh chat.
/// The hosting engine lends its session (`session.info`); the turn itself
/// runs between this process and the gateway, the reply streaming to
/// stdout. Without `--model` the server picks the org's default route.
pub fn cmd_chat(args: &[String]) -> anyhow::Result<()> {
    let text = args.last().context("missing prompt text")?.clone();
    let model = flag(args, "--model").unwrap_or_default();
    let session = DaemonClient::attach()?.call("session.info", json!({}))?;
    let cloud = CloudClient {
        base_url: session["base_url"]
            .as_str()
            .context("session.info returned no base_url")?
            .to_string(),
        token: session["token"]
            .as_str()
            .context("session.info returned no token")?
            .to_string(),
    };
    crate::machine_link::ensure_crypto_provider();
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    let done = rt.block_on(async {
        let chat_id = cloud.create_chat(None).await?;
        let stream = cloud
            .chat_stream(chat_id, &model, &[Message::user(text)])
            .await?;
        let mut out = std::io::stdout();
        let done = print_chat(stream, &mut out).await?;
        anyhow::Ok((chat_id, done))
    })?;
    println!();
    let (chat_id, (cost, tokens_in, tokens_out)) = done;
    eprintln!("cost ${cost:.6} ({tokens_in} in / {tokens_out} out, chat {chat_id})");
    Ok(())
}

/// Writes one plain completion's text deltas to `out` as they arrive and
/// returns the Done frame's (cost, tokens in, tokens out). An Error frame,
/// or a stream that ends without Done, is an error.
async fn print_chat(
    stream: impl futures::Stream<Item = Result<StreamEvent, CloudError>>,
    out: &mut impl std::io::Write,
) -> anyhow::Result<(f64, u32, u32)> {
    use futures::StreamExt as _;
    let mut stream = std::pin::pin!(stream);
    while let Some(item) = stream.next().await {
        match item? {
            StreamEvent::Delta { content } => {
                write!(out, "{content}")?;
                out.flush()?;
            }
            StreamEvent::Done {
                cost_usd,
                tokens_in,
                tokens_out,
                ..
            } => return Ok((cost_usd, tokens_in, tokens_out)),
            StreamEvent::Error { code, message } => {
                anyhow::bail!("stream error [{code}]: {message}")
            }
            // A plain completion declares no tools; reasoning and the other
            // frame kinds are not part of this surface.
            _ => {}
        }
    }
    anyhow::bail!("stream ended without done event")
}

pub fn cmd_publish(args: &[String]) -> anyhow::Result<()> {
    let kind = flag(args, "--kind")?;
    let dir = absolute_cli_path(&flag(args, "--dir")?)?;
    let version = flag(args, "--version")?;
    let mut client = DaemonClient::attach()?;
    let res = client.call(
        "registry.publish",
        json!({"kind": kind, "dir": dir, "version": version}),
    )?;
    println!(
        "published {} {} {}",
        kind,
        res["slug"].as_str().unwrap_or("?"),
        res["version"].as_str().unwrap_or("?")
    );
    Ok(())
}

pub fn cmd_install(args: &[String]) -> anyhow::Result<()> {
    let slug = flag(args, "--slug")?;
    let version = flag(args, "--version").ok();
    let project = absolute_cli_path(&flag(args, "--project").unwrap_or_else(|_| ".".into()))?;
    let mut client = DaemonClient::attach()?;
    let res = client.call(
        "registry.install",
        json!({"slug": slug, "version": version, "project_dir": project}),
    )?;
    println!(
        "installed {} -> {}",
        res["name"].as_str().unwrap_or("?"),
        res["path"].as_str().unwrap_or("?")
    );
    Ok(())
}

/// `verify --file F --sig SIG --key PUBKEY`: offline ed25519 check that a
/// downloaded release artifact matches its published signature. The digest
/// signed is sha256(F); both sig and pubkey are hex.
pub fn cmd_verify(args: &[String]) -> anyhow::Result<()> {
    use ed25519_dalek::{Signature, Verifier, VerifyingKey};
    use sha2::Digest as _;
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

/// Relative paths belong to the invoking shell, not the long-lived daemon.
fn absolute_cli_path(path: &str) -> anyhow::Result<PathBuf> {
    let path = PathBuf::from(path);
    Ok(if path.is_absolute() {
        path
    } else {
        std::env::current_dir()?.join(path)
    })
}

#[cfg(test)]
mod chat_tests {
    use super::*;
    use futures::stream;

    /// Deltas print as they arrive, non-text frames are skipped, Done ends
    /// the turn with its usage; an Error frame or a missing Done fails.
    #[tokio::test]
    async fn print_chat_streams_text_and_returns_the_done_usage() {
        let frames: Vec<Result<StreamEvent, CloudError>> = vec![
            Ok(StreamEvent::Delta {
                content: "hi ".into(),
            }),
            Ok(StreamEvent::ThinkingDelta {
                content: "hmm".into(),
            }),
            Ok(StreamEvent::Delta {
                content: "there".into(),
            }),
            Ok(StreamEvent::Done {
                message_id: uuid::Uuid::now_v7(),
                cost_usd: 0.02,
                tokens_in: 5,
                tokens_out: 3,
            }),
        ];
        let mut out = Vec::new();
        let done = print_chat(stream::iter(frames), &mut out).await.unwrap();
        assert_eq!(String::from_utf8(out).unwrap(), "hi there");
        assert_eq!(done, (0.02, 5, 3));

        let frames: Vec<Result<StreamEvent, CloudError>> = vec![Ok(StreamEvent::Error {
            code: "model".into(),
            message: "boom".into(),
        })];
        let err = print_chat(stream::iter(frames), &mut Vec::new())
            .await
            .unwrap_err();
        assert!(err.to_string().contains("boom"), "{err}");

        let frames: Vec<Result<StreamEvent, CloudError>> = vec![Ok(StreamEvent::Delta {
            content: "partial".into(),
        })];
        let err = print_chat(stream::iter(frames), &mut Vec::new())
            .await
            .unwrap_err();
        assert!(err.to_string().contains("without done"), "{err}");
    }
}

#[cfg(test)]
mod cli_path_tests {
    use super::*;
    #[test]
    fn paths_crossing_rpc_are_absolute_in_the_callers_directory() {
        assert_eq!(
            absolute_cli_path(".").unwrap(),
            std::env::current_dir().unwrap().join(".")
        );
        let absolute = std::env::temp_dir().join("guild-cli-path");
        assert_eq!(
            absolute_cli_path(absolute.to_str().unwrap()).unwrap(),
            absolute
        );
    }
}
