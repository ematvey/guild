import { describe, expect, it, vi } from "vitest";
import { consumeAuthFragment, parseAuthFragment, writeAddress } from "./route";

const NONCE = "a".repeat(64);

function memoryStorage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => void items.set(k, v),
    removeItem: (k: string) => void items.delete(k),
    items,
  };
}

const at = (pathname: string, search: string, hash: string) => ({ pathname, search, hash });

describe("parseAuthFragment", () => {
  it("reads a callback fragment and the address without it", () => {
    expect(parseAuthFragment(at("/chats", "?x=1", "#oidc_token=t&nonce=n"))).toEqual({
      fragment: "#oidc_token=t&nonce=n",
      canonicalUrl: "/chats?x=1",
    });
    expect(parseAuthFragment(at("/", "", "#oidc_token="))?.canonicalUrl).toBe("/");
  });

  it("ignores an address with no callback", () => {
    expect(parseAuthFragment(at("/chats", "", ""))).toBeNull();
    expect(parseAuthFragment(at("/chats", "", "#section"))).toBeNull();
    expect(parseAuthFragment(at("/chats", "", "#email=a&oidc_token=t"))).toBeNull();
  });
});

describe("consumeAuthFragment", () => {
  it("returns the token for this tab's pending login and spends its nonce", () => {
    const storage = memoryStorage({ "guild.oidc.nonce": NONCE });
    const out = consumeAuthFragment(at("/", "", `#oidc_token=tok&email=a%40b&nonce=${NONCE}`), storage);
    expect(out).toEqual({ token: "tok", canonicalUrl: "/" });
    expect(storage.items.size).toBe(0);
  });

  it("refuses a callback for another login but still yields the clean address", () => {
    const storage = memoryStorage({ "guild.oidc.nonce": NONCE });
    const out = consumeAuthFragment(at("/work", "", `#oidc_token=tok&nonce=${"b".repeat(64)}`), storage);
    expect(out).toEqual({ token: null, canonicalUrl: "/work" });
  });

  it("leaves storage alone when the address carries no callback", () => {
    const storage = memoryStorage({ "guild.oidc.nonce": NONCE });
    expect(consumeAuthFragment(at("/", "", ""), storage)).toBeNull();
    expect(storage.items.size).toBe(1);
  });
});

describe("writeAddress", () => {
  it("pushes by default and rewrites in place on replace", () => {
    const history = { pushState: vi.fn(), replaceState: vi.fn() };
    writeAddress("/a", undefined, history);
    writeAddress("/b", { replace: true }, history);
    expect(history.pushState).toHaveBeenCalledWith(null, "", "/a");
    expect(history.replaceState).toHaveBeenCalledWith(null, "", "/b");
  });
});
