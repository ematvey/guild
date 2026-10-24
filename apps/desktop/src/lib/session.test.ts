// Session addressing and token storage: the two modes (browser and Tauri)
// must resolve server URLs differently, and the token round-trip must
// survive a broken localStorage.

import { afterEach, describe, expect, it, vi } from "vitest";

function fakeStore(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
}

describe("session", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses the paired server URL in Tauri mode", async () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {}, location: { origin: "tauri://localhost" } });
    vi.stubGlobal("localStorage", fakeStore({ "guild.serverUrl": "https://guild.example/" }));
    const { apiUrl, serverBase, serverUrl } = await import("./session");
    expect(serverBase()).toBe("https://guild.example");
    expect(apiUrl("/api/v1/x")).toBe("https://guild.example/api/v1/x");
    expect(serverUrl()).toBe("https://guild.example");
  });

  it("falls back to the page origin in browser mode", async () => {
    vi.stubGlobal("window", { location: { origin: "http://localhost:18080" } });
    const { apiUrl, serverBase, serverUrl } = await import("./session");
    expect(serverBase()).toBe("");
    expect(apiUrl("/api/v1/x")).toBe("/api/v1/x");
    expect(serverUrl()).toBe("http://localhost:18080");
  });

  it("round-trips the bearer token", async () => {
    vi.stubGlobal("localStorage", fakeStore());
    const { clearToken, getToken, setToken } = await import("./session");
    setToken("tok");
    expect(getToken()).toBe("tok");
    clearToken();
    expect(getToken()).toBeNull();
  });

  it("treats a broken localStorage as signed out", async () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    });
    const { getToken, setToken } = await import("./session");
    expect(getToken()).toBeNull();
    expect(() => setToken("tok")).not.toThrow();
  });
});
