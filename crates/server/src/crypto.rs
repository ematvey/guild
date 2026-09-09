//! Secret encryption at rest: AES-256-GCM, random 12-byte nonce,
//! stored as `hex(nonce || ciphertext)` (spec §4.2).

use aes_gcm::aead::{Aead, KeyInit, OsRng};
use aes_gcm::{AeadCore, Aes256Gcm, Nonce};

const NONCE_LEN: usize = 12;

pub fn encrypt_secret(master_key: &[u8; 32], plaintext: &str) -> anyhow::Result<String> {
    let cipher = Aes256Gcm::new(master_key.into());
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let ct = cipher
        .encrypt(&nonce, plaintext.as_bytes())
        .map_err(|e| anyhow::anyhow!("encrypt failed: {e}"))?;
    let mut out = nonce.to_vec();
    out.extend_from_slice(&ct);
    Ok(hex::encode(out))
}

pub fn decrypt_secret(master_key: &[u8; 32], encoded: &str) -> anyhow::Result<String> {
    let bytes = hex::decode(encoded)?;
    if bytes.len() <= NONCE_LEN {
        anyhow::bail!("ciphertext too short");
    }
    let (nonce, ct) = bytes.split_at(NONCE_LEN);
    let cipher = Aes256Gcm::new(master_key.into());
    let pt = cipher
        .decrypt(Nonce::from_slice(nonce), ct)
        .map_err(|e| anyhow::anyhow!("decrypt failed: {e}"))?;
    String::from_utf8(pt).map_err(|e| anyhow::anyhow!("decrypted secret not utf8: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_and_wrong_key_fails() {
        let key = [7u8; 32];
        let enc = encrypt_secret(&key, "sk-super-secret").unwrap();
        assert_eq!(decrypt_secret(&key, &enc).unwrap(), "sk-super-secret");
        let wrong = [8u8; 32];
        assert!(decrypt_secret(&wrong, &enc).is_err());
    }
}
