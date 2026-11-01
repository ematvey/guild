// The Web Push sender against a fake push service: the request must carry the
// VAPID JWT and an aes128gcm body this test decrypts on its own (RFC 8291),
// with the subscription's private key. That proves the wiring — keys, headers,
// payload — independently of the library that encrypts it.

import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttpsServer, type Server } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import webpush from "web-push";
import { webPushSender } from "../push/sender.js";
import { pushSubject } from "../push/vapid.js";

const b64url = (buf: Buffer): string =>
  buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const fromB64url = (value: string): Buffer =>
  Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");

/** A browser's subscription: a P-256 key pair plus the 16-byte auth secret. */
function browserKeys(): { privateKey: crypto.KeyObject; publicRaw: Buffer; auth: Buffer } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const publicRaw = Buffer.from(publicKey.export({ type: "spki", format: "der" }).subarray(-65));
  return { privateKey, publicRaw, auth: crypto.randomBytes(16) };
}

interface Captured {
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

let server: Server | undefined;
// web-push posts over TLS and trusts only real CAs; the fake service is
// self-signed, so verification is off for this file only. The material is
// built at import time so `skipIf` can see it.
const tls = makeTls();
const previousTlsSetting = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

function makeTls(): { key: Buffer; cert: Buffer } | undefined {
  const dir = mkdtempSync(join(tmpdir(), "guild-push-tls-"));
  try {
    execFileSync(
      "openssl",
      [
        "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
        "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"),
        "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1",
      ],
      { stdio: "ignore" },
    );
    return { key: readFileSync(join(dir, "key.pem")), cert: readFileSync(join(dir, "cert.pem")) };
  } catch {
    return undefined; // no openssl: the TLS tests skip
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

afterAll(() => {
  if (previousTlsSetting === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousTlsSetting;
});

afterEach(async () => {
  await new Promise<void>((resolve) => (server === undefined ? resolve() : server.close(() => resolve())));
  server = undefined;
});

async function listen(): Promise<{ endpoint: string; next: () => Promise<Captured> }> {
  if (tls === undefined) throw new Error("no TLS material");
  const queue: Captured[] = [];
  const waiters: ((value: Captured) => void)[] = [];
  server = createHttpsServer(tls, (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const captured = { headers: req.headers, body: Buffer.concat(chunks) };
      const waiter = waiters.shift();
      if (waiter !== undefined) waiter(captured);
      else queue.push(captured);
      res.writeHead(201).end();
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const port = (server!.address() as AddressInfo).port;
  return {
    endpoint: `https://127.0.0.1:${port}/push`,
    next: () =>
      new Promise<Captured>((resolve) => {
        const ready = queue.shift();
        if (ready !== undefined) resolve(ready);
        else waiters.push(resolve);
      }),
  };
}

/** RFC 8291: derive the content key and nonce, then open the aes128gcm body. */
function decrypt(captured: Captured, keys: ReturnType<typeof browserKeys>): string {
  const body = captured.body;
  const salt = body.subarray(0, 16);
  const idLength = body.readUInt8(20);
  const serverPublic = body.subarray(21, 21 + idLength);
  const ciphertext = body.subarray(21 + idLength);

  const ephemeral = crypto.createPublicKey({
    key: Buffer.concat([Buffer.from("3059301306072a8648ce3d020106082a8648ce3d030107034200", "hex"), serverPublic]),
    format: "der",
    type: "spki",
  });
  const shared = crypto.diffieHellman({ privateKey: keys.privateKey, publicKey: ephemeral });

  const hkdf = (saltBytes: Buffer, ikm: Buffer, info: Buffer, length: number): Buffer =>
    Buffer.from(crypto.hkdfSync("sha256", ikm, saltBytes, info, length));

  const prk = hkdf(
    keys.auth,
    shared,
    Buffer.concat([Buffer.from("WebPush: info\0"), keys.publicRaw, serverPublic]),
    32,
  );
  const cek = hkdf(salt, prk, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdf(salt, prk, Buffer.from("Content-Encoding: nonce\0"), 12);

  const decipher = crypto.createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  const plain = Buffer.concat([
    decipher.update(ciphertext.subarray(0, ciphertext.length - 16)),
    decipher.final(),
  ]);
  // The last record ends with the padding delimiter 0x02.
  const end = plain.length - 1;
  expect(plain[end]).toBe(0x02);
  return plain.subarray(0, end).toString("utf8");
}

describe("webPushSender", () => {
  it.skipIf(tls === undefined)("sends a VAPID-signed aes128gcm payload the subscription can open", async () => {
    const { endpoint, next } = await listen();
    const keys = browserKeys();
    const vapid = webpush.generateVAPIDKeys();
    const sender = webPushSender(vapid, "https://guild.example");

    const pending = sender.send(
      { endpoint, p256dh: b64url(keys.publicRaw), auth: b64url(keys.auth) },
      { title: "Weekly", body: "The answer is ready.", url: "/thread/c1", tag: "chat-c1", chat_id: "c1" },
      "chat-c1",
    );
    const captured = await next();
    expect(await pending).toEqual({ outcome: "ok" });

    expect(captured.headers["content-encoding"]).toBe("aes128gcm");
    expect(captured.headers["content-type"]).toBe("application/octet-stream");
    expect(captured.headers.ttl).toBeDefined();
    expect(captured.headers.topic).toBe("chat-c1");

    // The Authorization header names this server and signs the push.
    const authorization = String(captured.headers.authorization);
    expect(authorization.startsWith("vapid t=")).toBe(true);
    const [token, keyParam] = authorization.slice("vapid ".length).split(",");
    expect(String(keyParam).trim()).toBe(`k=${vapid.publicKey}`);
    const jwt = String(token).slice(2);
    const [header, claims] = jwt.split(".");
    expect(JSON.parse(fromB64url(String(header)).toString())).toMatchObject({ alg: "ES256", typ: "JWT" });
    const parsed = JSON.parse(fromB64url(String(claims)).toString()) as { aud: string; sub: string; exp: number };
    expect(parsed.aud).toBe(`https://127.0.0.1:${new URL(endpoint).port}`);
    expect(parsed.sub).toBe("https://guild.example");
    expect(parsed.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));

    // And the body decrypts to exactly what was sent.
    const payload = JSON.parse(decrypt(captured, keys)) as Record<string, string>;
    expect(payload).toMatchObject({ title: "Weekly", body: "The answer is ready.", url: "/thread/c1", chat_id: "c1" });
  });

  it.skipIf(tls === undefined)("reports a dead endpoint as gone, not as a retryable failure", async () => {
    server = createHttpsServer(tls!, (_req, res) => res.writeHead(410).end());
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const keys = browserKeys();
    const sender = webPushSender(webpush.generateVAPIDKeys(), "https://guild.example");
    const result = await sender.send(
      { endpoint: `https://127.0.0.1:${port}/push`, p256dh: b64url(keys.publicRaw), auth: b64url(keys.auth) },
      { title: "t", body: "b", url: "/chats" },
    );
    expect(result.outcome).toBe("gone");
  });

  it.skipIf(tls === undefined)("reports a server error as a retryable failure", async () => {
    server = createHttpsServer(tls!, (_req, res) => res.writeHead(503).end());
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const keys = browserKeys();
    const sender = webPushSender(webpush.generateVAPIDKeys(), "https://guild.example");
    const result = await sender.send(
      { endpoint: `https://127.0.0.1:${port}/push`, p256dh: b64url(keys.publicRaw), auth: b64url(keys.auth) },
      { title: "t", body: "b", url: "/chats" },
    );
    expect(result.outcome).toBe("failed");
    expect(result.error).toContain("503");
  });
});

describe("pushSubject", () => {
  it("uses the public origin when it is https", () => {
    expect(pushSubject({ apiUrl: "https://guild.example/" })).toBe("https://guild.example");
  });

  it("falls back to a mailto for a plain-http deployment", () => {
    // VAPID rejects an http subject; the container's own base is http.
    expect(pushSubject({ apiUrl: "http://localhost:18080" })).toBe("mailto:guild@localhost");
    expect(pushSubject({ apiUrl: "not a url" })).toBe("mailto:guild@localhost");
  });
});
