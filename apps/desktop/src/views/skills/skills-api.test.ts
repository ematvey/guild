// Tests for the skills API's `send()` helper: a caller that passes its own
// headers (the JSON-bodied actions set content-type) must not lose the
// Authorization header. Mocks global fetch to capture the URL + init it
// receives. Also covers the editor's save target (POST create / PUT edit),
// the teams list the owner selector uses, and the error contract: a refusal
// throws the server's ApiError.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  myTeams,
  skillsGate,
  skillsInstall,
  skillsSave,
  skillsUninstall,
} from "./skills-api";
import { formatVersion } from "./version";
import { ApiError } from "../../lib/api/request";

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

function captureFetch(): { urls: string[]; inits: RequestInit[] } {
  const urls: string[] = [];
  const inits: RequestInit[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      urls.push(String(input));
      inits.push(init ?? {});
      return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
  return { urls, inits };
}

describe("send() header merge", () => {
  it("keeps Authorization when the caller passes content-type (install)", async () => {
    const { inits } = captureFetch();
    await skillsInstall("code-review", "v3");
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

describe("skillsSave (the editor's save target)", () => {
  it("create mode POSTs the payload to /api/v1/skills", async () => {
    const { urls, inits } = captureFetch();
    const payload = { slug: "code-review", description: "d", body: "# hi" };
    await skillsSave({ method: "POST", path: "/api/v1/skills", body: payload });
    expect(urls[0]).toContain("/api/v1/skills");
    expect(inits[0]?.method).toBe("POST");
    expect(inits[0]?.body).toBe(JSON.stringify(payload));
  });

  it("edit mode PUTs the payload to /api/v1/skills/:slug", async () => {
    const { urls, inits } = captureFetch();
    const payload = { description: "d", body: "# hi" };
    await skillsSave({ method: "PUT", path: "/api/v1/skills/code-review", body: payload });
    expect(urls[0]).toContain("/api/v1/skills/code-review");
    expect(inits[0]?.method).toBe("PUT");
    expect(inits[0]?.body).toBe(JSON.stringify(payload));
  });

  it("throws a 409 slug_taken as an ApiError with the server message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: { code: "slug_taken", message: "a skill with this slug already exists" } }), {
          status: 409,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const error = await skillsSave({
      method: "POST",
      path: "/api/v1/skills",
      body: { slug: "taken", description: "", body: "" },
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409, code: "slug_taken", message: "a skill with this slug already exists" });
  });
});

describe("myTeams (the owner selector's team list)", () => {
  it("maps the caller's membership list to id + name", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        urls.push(String(input));
        return new Response(JSON.stringify({ teams: [{ id: "t1", name: "Platform" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    expect(await myTeams()).toEqual([{ id: "t1", name: "Platform" }]);
    expect(urls[0]).toContain("/api/v1/skills/teams");
  });

  it("throws an ApiError on failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 })),
    );
    await expect(myTeams()).rejects.toBeInstanceOf(ApiError);
  });
});

describe("formatVersion", () => {
  it("renders exactly one v prefix for server-computed versions", () => {
    expect(formatVersion("v1")).toBe("v1");
    expect(formatVersion("v12")).toBe("v12");
  });

  it("prefixes bare user-published versions", () => {
    expect(formatVersion("0.1.0")).toBe("v0.1.0");
    expect(formatVersion("2")).toBe("v2");
  });
});
