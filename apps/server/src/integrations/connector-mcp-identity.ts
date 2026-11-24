import { verify, type KeyObject } from "node:crypto";
import type { JsonObject } from "./shared.js";

export function delegatedIdentity(
  authorization: string,
  key: KeyObject,
  issuer: string,
  orgId: string,
): { memberId: string; actingAs: string | null } | null {
  if (!authorization.startsWith("Bearer ") || authorization.length > 8192) return null;
  const parts = authorization.slice(7).split(".");
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts as [string, string, string];
  const now = Math.floor(Date.now() / 1000);
  try {
    if (!verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), key, Buffer.from(signature, "base64url"))) return null;
    const protectedHeader = JSON.parse(Buffer.from(header, "base64url").toString()) as JsonObject;
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString()) as JsonObject;
    if (protectedHeader["alg"] !== "RS256" || protectedHeader["kid"] !== "guild-workload" ||
        claims["iss"] !== issuer || claims["aud"] !== "guild-agentgateway" || claims["scope"] !== "mcp" ||
        claims["org"] !== orgId || typeof claims["sub"] !== "string" || claims["sub"] === "" ||
        typeof claims["exp"] !== "number" || claims["exp"] <= now || claims["exp"] > now + 90) return null;
    const email = claims["acting_as"];
    return { memberId: claims["sub"], actingAs: typeof email === "string" && email !== "" ? email : null };
  } catch {
    return null;
  }
}
