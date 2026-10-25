import { afterEach, describe, expect, it, vi } from "vitest";

// afterAuth adopts the new server/token in localStorage BEFORE calling
// apiMe: the profile lookup reads both from storage, so a fresh admin
// login must hit the paired server with the new token — the old order
// (fetch first, store after) sent a stale/missing credential and every
// fresh login deterministically fell back to the member profile.
describe("apiMe uses the adopted credential", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the freshly stored token to the freshly stored server", async () => {
    // Tauri mode: the base URL comes from localStorage (web mode is
    // same-origin and can't exercise the URL half).
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    const { apiMe } = await import("./api/servers");
    const { setToken } = await import("./session");

    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
    const calls: { url: string; auth: string | null }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        auth: (init?.headers as Record<string, string>)?.authorization ?? null,
      });
      return { status: 200, json: async () => ({ email: "a@b.c", role: "admin" }) };
    }));

    // afterAuth's order: store, then fetch.
    localStorage.setItem("guild.serverUrl", "https://guild.example");
    setToken("fresh-token");
    const me = await apiMe();
    expect(me?.role).toBe("admin");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://guild.example/api/v1/auth/me");
    expect(calls[0].auth).toBe("Bearer fresh-token");

    // with nothing stored (the pre-adopt state) there is no profile call
    localStorage.removeItem("guild_token");
    expect(await apiMe()).toBeNull();
  });
});
