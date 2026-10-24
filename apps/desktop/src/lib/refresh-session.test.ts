import { afterEach, describe, expect, it, vi } from "vitest";

// The refresh response is applied only while the credential it was started
// with is still installed: a response delivered after sign-out (or after
// another account signed in) is stale and must not overwrite the newer
// bearer. The single-flight promise is scoped to the same credential.
describe("refreshSession ignores stale responses", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubBrowser(fetchImpl: (input: string | URL, init?: RequestInit) => Promise<any>) {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
      calls.push(`${input} ${(init?.headers as Record<string, string>)?.authorization ?? ""}`);
      return fetchImpl(input, init);
    }));
    return { calls, store };
  }

  it("a late refresh response never overwrites a newer credential", async () => {
    let release: (v: any) => void = () => {};
    const gate = new Promise((resolve) => (release = resolve));
    const { calls } = stubBrowser(async () => {
      await gate;
      return { status: 200, ok: true, json: async () => ({ token: "stale-A" }) };
    });
    const { refreshSession, setToken, clearToken, getToken } = await import("./session");

    setToken("A");
    const pending = refreshSession();
    expect(calls[0]).toContain("Bearer A");

    // The account signs out and another signs in while A's refresh hangs.
    clearToken();
    setToken("B");
    release({ status: 200, json: async () => ({ token: "stale-A" }) });
    await pending;

    expect(getToken()).toBe("B");
  });

  it("a fresh account's refresh still applies its own response", async () => {
    const { calls } = stubBrowser(async () => ({
      status: 200,
      ok: true, json: async () => ({ token: "rotated" }),
    }));
    const { refreshSession, setToken, getToken } = await import("./session");

    setToken("B");
    await refreshSession();
    expect(calls[0]).toContain("Bearer B");
    expect(getToken()).toBe("rotated");
  });

  it("concurrent refreshes for the same credential share one request", async () => {
    let release: (v: any) => void = () => {};
    const gate = new Promise((resolve) => (release = resolve));
    const { calls } = stubBrowser(async () => {
      await gate;
      return { status: 200, ok: true, json: async () => ({ token: "rotated" }) };
    });
    const { refreshSession, setToken } = await import("./session");

    setToken("A");
    const a = refreshSession();
    const b = refreshSession();
    release(undefined);
    await Promise.all([a, b]);
    expect(calls).toHaveLength(1);
  });
});
