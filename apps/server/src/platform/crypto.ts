// Shared crypto primitives for the platform layer, matching the Rust
// era's stored formats byte-for-byte (see the migration SQL):
//   - passwords: argon2id v19, m=19456 t=2 p=1, PHC string (Argon2::default)
//   - tokens/codes: 32 random bytes hex-encoded; only sha256 stored
//   - secrets at rest: AES-256-GCM, hex(nonce || ciphertext+tag)

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import argon2 from "@node-rs/argon2";

const MASTER_KEY_LEN = 32;
const AES_NONCE_LEN = 12;
const AES_TAG_LEN = 16;

export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export function randomToken(): string {
  return randomBytes(32).toString("hex");
}

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, {
    algorithm: argon2.Algorithm.Argon2id,
    version: argon2.Version.V0x13,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    // Unparseable hash: no match (Rust PasswordHash::new error path).
    return false;
  }
}

export function masterKeyBytes(masterKeyHex: string): Buffer {
  const key = Buffer.from(masterKeyHex, "hex");
  if (key.length !== MASTER_KEY_LEN) {
    throw new Error("master key must decode to 32 bytes");
  }
  return key;
}

/** AES-256-GCM with a random 12-byte nonce; hex(nonce || ciphertext+tag). */
export function encryptSecret(masterKey: Buffer, plaintext: string): string {
  const nonce = randomBytes(AES_NONCE_LEN);
  const cipher = createCipheriv("aes-256-gcm", masterKey, nonce);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return Buffer.concat([nonce, ct]).toString("hex");
}

export function decryptSecret(masterKey: Buffer, encoded: string): string {
  const bytes = Buffer.from(encoded, "hex");
  if (bytes.length <= AES_NONCE_LEN) {
    throw new Error("ciphertext too short");
  }
  const nonce = bytes.subarray(0, AES_NONCE_LEN);
  const tag = bytes.subarray(bytes.length - AES_TAG_LEN);
  const ct = bytes.subarray(AES_NONCE_LEN, bytes.length - AES_TAG_LEN);
  const decipher = createDecipheriv("aes-256-gcm", masterKey, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

/** One bullet per stored character, capped so very long secrets don't blow
 *  out the placeholder line. */
export function maskSecretLen(len: number): string {
  return "•".repeat(Math.min(Math.max(len, 1), 48));
}
