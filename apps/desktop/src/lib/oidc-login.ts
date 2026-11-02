const NONCE_KEY = "guild.oidc.nonce";
type LoginStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function beginOidcLogin(org: string, storage: LoginStorage = sessionStorage): string {
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
  storage.setItem(NONCE_KEY, nonce);
  return `/api/v1/auth/oidc/login?org_id=${encodeURIComponent(org)}&nonce=${nonce}`;
}

/** Only a callback for this tab's pending login may replace its session. */
export function consumeOidcLogin(fragment: string, storage: LoginStorage = sessionStorage): string | null {
  const params = new URLSearchParams(fragment.replace(/^#/, ""));
  const expected = storage.getItem(NONCE_KEY);
  storage.removeItem(NONCE_KEY);
  const nonce = params.get("nonce");
  if (!expected || !/^[0-9a-f]{64}$/.test(expected) || nonce !== expected) return null;
  return params.get("oidc_token") || null;
}
