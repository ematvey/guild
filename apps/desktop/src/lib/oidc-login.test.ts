import { describe, it, expect } from "vitest";
import { beginOidcLogin, consumeOidcLogin } from "./oidc-login";
const storage = () => {
  const values = new Map<string, string>();
  return {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => {
      values.set(k, v);
    },
    removeItem: (k: string) => {
      values.delete(k);
    },
  };
};
describe("browser-bound OIDC", () => {
  it("accepts its tab's callback once", () => {
    const s = storage();
    const nonce = new URL(beginOidcLogin("org", s), "https://guild.test").searchParams.get("nonce");
    const fragment = `#oidc_token=legit&nonce=${nonce}`;
    expect(consumeOidcLogin(fragment, s)).toBe("legit");
    expect(consumeOidcLogin(fragment, s)).toBeNull();
  });
  it("rejects unsolicited, foreign-tab, and legacy token URLs", () => {
    const s = storage();
    const nonce = new URL(beginOidcLogin("org", s), "https://guild.test").searchParams.get("nonce");
    expect(consumeOidcLogin(`#oidc_token=attacker&nonce=${nonce}`, storage())).toBeNull();
    expect(consumeOidcLogin("#oidc_token=attacker&nonce=wrong", s)).toBeNull();
    beginOidcLogin("org", s);
    expect(consumeOidcLogin("#oidc_token=attacker", s)).toBeNull();
  });
});
