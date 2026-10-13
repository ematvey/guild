// Tests for the skills API's `send()` helper: a caller that passes its own
// headers (the JSON-bodied actions set content-type) must not lose the
// Authorization header. Mocks global fetch to capture the init it receives.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { skillsGate, skillsInstall, skillsUninstall } from "./skills-api";

const token = "test-token-123";

beforeEach(() => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => (key === "guild_token" ? token : null),
    setItem: () => {},
    removeItem: () => {},
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function captureFetch(): { inits: RequestInit[] } {
  const inits: RequestInit[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: string | URL, init?: RequestInit) => {
      inits.push(init ?? {});
      return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
  return { inits };
}

describe("send() header merge", () => {
  it("keeps Authorization when the caller passes content-type (install)", async () => {
    const { inits } = captureFetch();
    const res = await skillsInstall("code-review", "v3");
    expect(res.ok).toBe(true);
    const headers = new Headers(inits[0]?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${token}`);
    expect(headers.get("content-type")).toBe("application/json");
    expect(inits[0]?.method).toBe("POST");
    expect(inits[0]?.body).toBe(JSON.stringify({ version: "v3" }));
  });

  it("merges headers on gate too, and keeps Authorization when the caller sends no headers", async () => {
    const { inits } = captureFetch();
    await skillsGate("code-review", true);
    const gateHeaders = new Headers(inits[0]?.headers);
    expect(gateHeaders.get("authorization")).toBe(`Bearer ${token}`);
    expect(gateHeaders.get("content-type")).toBe("application/json");

    await skillsUninstall("code-review");
    const plainHeaders = new Headers(inits[1]?.headers);
    expect(plainHeaders.get("authorization")).toBe(`Bearer ${token}`);
  });
});
