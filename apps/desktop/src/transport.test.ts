import { afterEach, describe, expect, it, vi } from "vitest";

// orgSkillsApi's skillBody must carry the caller's pinned version in the
// query string — without it the server serves its own resolution order
// (explicit query → the user's pin → latest), and a browser session whose
// pin the server can't see (or that pins an older version deliberately)
// would expand the wrong body.
describe("orgSkillsApi.skillBody pins the version", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function setup() {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    const { orgSkillsApi, setToken } = await import("./transport");
    const store = new Map<string, string>([
      ["guild.serverUrl", "https://guild.example"],
      ["guild_token", "tok"],
    ]);
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
      urls.push(String(input));
      return { ok: true, json: async () => ({ skill_md: "BODY" }) };
    }));
    setToken("tok");
    return { api: orgSkillsApi(), urls };
  }

  it("appends ?version= when a version is given", async () => {
    const { api, urls } = await setup();
    const body = await api.skillBody("deploy-checklist", "v2");
    expect(body).toBe("BODY");
    expect(urls).toEqual(["https://guild.example/api/v1/skills/deploy-checklist/source?version=v2"]);
  });

  it("fetches without a query when no version is given", async () => {
    const { api, urls } = await setup();
    expect(await api.skillBody("deploy-checklist")).toBe("BODY");
    expect(urls).toEqual(["https://guild.example/api/v1/skills/deploy-checklist/source"]);
  });
});

describe("settings reads distinguish failures from defaults", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each(["getApproval", "getAssistantPrompt"] as const)("%s rejects failed reads", async (name) => {
    const transport = await import("./transport");
    vi.stubGlobal("localStorage", { getItem: () => null });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unavailable", { status: 503 })));
    await expect(transport[name]()).rejects.toThrow("503");
  });

  it("preserves a successful absent assistant override", async () => {
    const { getAssistantPrompt } = await import("./transport");
    vi.stubGlobal("localStorage", { getItem: () => null });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ prompt: null }), { status: 200 })));
    await expect(getAssistantPrompt()).resolves.toBeNull();
  });
});
