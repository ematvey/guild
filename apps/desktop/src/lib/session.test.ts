// Session addressing and token storage: the two modes (browser and Tauri)
// must resolve server URLs differently, and the token round-trip must
// survive a broken localStorage.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { InstallSurface } from "./session";

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

  it("names the HTTP status when a proxy answers without a message", async () => {
    vi.stubGlobal("window", { location: { origin: "http://localhost:18080" } });
    vi.stubGlobal("localStorage", fakeStore({ guild_token: "tok" }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 502,
        statusText: "",
        json: async () => {
          throw new SyntaxError("Unexpected token '<'");
        },
      })),
    );
    const { mintTicket } = await import("./session");
    await expect(mintTicket()).rejects.toThrow("The server answered HTTP 502");
  });
});

// ---- install state -----------------------------------------------------------
// iOS installs a web app only from Safari's Share sheet, and only the
// installed copy can receive Web Push later, so the four cases must stay
// distinct.

const surface = (over: Partial<InstallSurface> = {}): InstallSurface => ({
  userAgent:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  platform: "iPhone",
  maxTouchPoints: 5,
  standalone: false,
  displayStandalone: false,
  ...over,
});

const MAC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";

describe("install state", () => {
  it("reports an iOS Safari tab as installable", async () => {
    const { installOffered, installState } = await import("./session");
    expect(installState(surface())).toBe("ios-safari");
    expect(installOffered(surface())).toBe(true);
  });

  it("reports the installed copy, from either flag", async () => {
    const { installOffered, installState } = await import("./session");
    expect(installState(surface({ standalone: true }))).toBe("installed");
    expect(installState(surface({ displayStandalone: true }))).toBe("installed");
    expect(installOffered(surface({ standalone: true }))).toBe(false);
  });

  it("rejects every other iOS browser, which cannot install", async () => {
    const { installOffered, installState } = await import("./session");
    for (const marker of ["CriOS/120", "FxiOS/120", "EdgiOS/120", "OPiOS/120"]) {
      const s = surface({
        userAgent: `Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) ${marker} Mobile/15E148 Safari/604.1`,
      });
      expect(installState(s)).toBe("ios-browser");
      expect(installOffered(s)).toBe(true);
    }
  });

  it("treats iPadOS as iOS, not as a Mac", async () => {
    const { installState, isIOS } = await import("./session");
    const ipad = surface({ userAgent: MAC_UA, platform: "MacIntel", maxTouchPoints: 5 });
    expect(isIOS(ipad)).toBe(true);
    expect(installState(ipad)).toBe("ios-safari");
  });

  it("leaves desktop alone, including a touchless Mac", async () => {
    const { installOffered, installState, isIOS } = await import("./session");
    const mac = surface({ userAgent: MAC_UA, platform: "MacIntel", maxTouchPoints: 0 });
    expect(isIOS(mac)).toBe(false);
    expect(installState(mac)).toBe("other");
    expect(installOffered(mac)).toBe(false);
  });

  it("offers Android Chrome its menu steps", async () => {
    const { installOffered, installState } = await import("./session");
    const android = surface({
      userAgent:
        "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36",
      platform: "Linux armv8l",
      maxTouchPoints: 5,
    });
    expect(installState(android)).toBe("android");
    expect(installOffered(android)).toBe(true);
  });
});
