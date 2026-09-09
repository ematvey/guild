//! Release artifact signing (ed25519 over the artifact's sha256 digest).
//! Key source, in order: `GUILD_RELEASE_SIGNING_SEED` env (hex, 32 bytes),
//! the auto-generated seed persisted in `server_kv`, or generate-once.

use crate::state::AppState;
use anyhow::Context as _;
use ed25519_dalek::{Signature, Signer, SigningKey};

pub const SIGNING_SEED_KV: &str = "release_signing_seed";

pub async fn signing_key(state: &AppState) -> anyhow::Result<SigningKey> {
    let seed_hex = if let Ok(env_seed) = std::env::var("GUILD_RELEASE_SIGNING_SEED") {
        Some(env_seed)
    } else {
        let store = match state.store().await {
            Ok(s) => s,
            Err(e) => return Err(anyhow::anyhow!("store unavailable: {}", e.message)),
        };
        let existing = match store.kv().get(SIGNING_SEED_KV).await {
            Ok(v) => v,
            Err(e) => return Err(anyhow::anyhow!("kv read failed: {}", e.message)),
        };
        if let Some(seed) = existing {
            Some(seed)
        } else {
            use rand::RngCore;
            let mut bytes = [0u8; 32];
            rand::rngs::OsRng.fill_bytes(&mut bytes);
            let hex_seed = hex::encode(bytes);
            if let Err(e) = store.kv().put(SIGNING_SEED_KV, &hex_seed).await {
                return Err(anyhow::anyhow!("kv write failed: {}", e.message));
            }
            Some(hex_seed)
        }
    };
    let seed_hex = seed_hex.context("no signing seed available")?;
    let bytes: [u8; 32] = hex::decode(seed_hex.trim())
        .context("signing seed is not hex")?
        .try_into()
        .map_err(|_| anyhow::anyhow!("signing seed must be 32 bytes"))?;
    Ok(SigningKey::from_bytes(&bytes))
}

/// Signs the 32-byte sha256 digest of an artifact; returns the hex signature.
pub fn sign_digest(key: &SigningKey, digest: &[u8; 32]) -> String {
    hex::encode(key.sign(digest).to_bytes())
}

/// Verifies a hex signature over a digest (used by tests and the verify path).
pub fn verify_digest(
    public_key: &[u8; 32],
    digest: &[u8; 32],
    sig_hex: &str,
) -> anyhow::Result<()> {
    use ed25519_dalek::{Verifier, VerifyingKey};
    let vk = VerifyingKey::from_bytes(public_key)?;
    let sig_bytes: [u8; 64] = hex::decode(sig_hex)?
        .try_into()
        .map_err(|_| anyhow::anyhow!("signature must be 64 bytes"))?;
    vk.verify(digest, &Signature::from_bytes(&sig_bytes))?;
    Ok(())
}
