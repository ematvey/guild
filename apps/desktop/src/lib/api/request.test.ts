import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, request } from "./request";

const store = new Map<string, string>();

beforeEach(() => {
  store.clear();
  store.set("guild_token", "tok");
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("request", () => {
  it("sends the bearer and a JSON body, and parses the answer", async () => {
    const calls: RequestInit[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        calls.push(init);
        return json(200, { agent: { id: "a1" } });
      }),
    );
    const v = await request<{ agent: { id: string } }>("POST", "/api/v1/agents", { name: "x" });
    expect(v.agent.id).toBe("a1");
    expect(calls[0]?.body).toBe(JSON.stringify({ name: "x" }));
    expect((calls[0]!.headers as Record<string, string>).authorization).toBe("Bearer tok");
  });

  it("resolves an empty answer to undefined", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 204 })),
    );
    expect(await request("DELETE", "/api/v1/x")).toBeUndefined();
  });

  it("fails with the server's code and message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(409, { error: { code: "slug_taken", message: "a skill with this slug already exists" } })),
    );
    const error = await request("POST", "/api/v1/skills", {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code: "slug_taken", status: 409, message: "a skill with this slug already exists" });
  });

  it("falls back to the HTTP status for a non-JSON error body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>bad gateway</html>", { status: 502 })),
    );
    const error = await request("GET", "/api/v1/x").catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "http_502", status: 502, message: "The server answered HTTP 502" });
  });

  it("refreshes the session once on 401 and retries with the new token", async () => {
    const auth: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        if (url.endsWith("/api/v1/auth/refresh")) return json(200, { token: "fresh" });
        auth.push((init.headers as Record<string, string>).authorization);
        return auth.length === 1
          ? json(401, { error: { code: "unauthorized", message: "expired" } })
          : json(200, { ok: true });
      }),
    );
    expect(await request("GET", "/api/v1/x")).toEqual({ ok: true });
    expect(auth).toEqual(["Bearer tok", "Bearer fresh"]);
  });

  it("fails as unauthorized when the refresh is refused", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(401, { error: { code: "unauthorized", message: "expired" } })),
    );
    const error = await request("GET", "/api/v1/x").catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "unauthorized", status: 401 });
    expect(store.get("guild_token")).toBe("tok");
  });
});
