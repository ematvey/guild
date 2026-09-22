//! Headless CLI verbs. All cloud-touching verbs go through the local daemon
//! (the only session-token route to the server, spec §3.3); `verify` stays
//! offline. Shared by the guild-app-server and Guild binaries.

use crate::daemon_client::DaemonClient;
use anyhow::Context as _;
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

/// The daemon should be a copy of this very binary (single-binary design).
fn this_bin() -> anyhow::Result<PathBuf> {
    std::env::current_exe().context("no current exe")
}

pub fn cmd_login(args: &[String]) -> anyhow::Result<()> {
    let mut client = DaemonClient::attach(&this_bin()?)?;
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

pub fn cmd_chat(args: &[String]) -> anyhow::Result<()> {
    let text = args.last().context("missing prompt text")?.clone();
    let model = flag(args, "--model").unwrap_or_else(|_| "gpt-4o-mini".into());
    let mut client = DaemonClient::attach(&this_bin()?)?;
    let (res, events) = client.call_until_event(
        "chat.send",
        json!({"text": text, "model": model}),
        "chat.done",
    )?;
    for ev in &events {
        if ev["event"] == "chat.delta" {
            if let Some(c) = ev["payload"]["content"].as_str() {
                print!("{c}");
            }
        }
    }
    println!();
    if let Some(chat_id) = res["chat_id"].as_str() {
        if let Some(cost) = res["cost_usd"].as_f64() {
            eprintln!(
                "cost ${cost:.6} ({} in / {} out, chat {chat_id})",
                res["tokens_in"], res["tokens_out"]
            );
        }
    }
    Ok(())
}

pub fn cmd_publish(args: &[String]) -> anyhow::Result<()> {
    let kind = flag(args, "--kind")?;
    let dir = flag(args, "--dir")?;
    let version = flag(args, "--version")?;
    let mut client = DaemonClient::attach(&this_bin()?)?;
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
    let project = flag(args, "--project").unwrap_or_else(|_| ".".into());
    let mut client = DaemonClient::attach(&this_bin()?)?;
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
