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

// The machine registry is keyed by an id the server derives from the
// hardware fingerprint (org + user + MachineGuid/machine-id/IOPlatformUUID),
// so a client whose local storage was wiped re-attaches to its machine
// instead of forking a second one. The desktop has to agree with the server
// on its own id, or every local chat renders as remote.
describe("machine identity follows the server's derived id", () => {
  afterEach(() => vi.unstubAllGlobals());

  const row = (machine_id: string, hardware_fingerprint: string | null) => ({
    machine_id,
    name: "WORKSTATION",
    hardware_fingerprint,
    first_connected_at: "2026-10-18T19:00:00Z",
    last_connected_at: "2026-10-18T19:00:00Z",
    last_seen_at: "2026-10-18T19:00:00Z",
    connected: true,
  });

  it("matches this computer's row by hardware fingerprint, ignoring case", async () => {
    const { machineIdForFingerprint } = await import("./transport");
    const machines = [row("other", "b8f0"), row("mine", "1B12A6D6-A24C-4434-AFDF-DB69E6920889")];
    expect(machineIdForFingerprint(machines, "1b12a6d6-a24c-4434-afdf-db69e6920889")).toBe("mine");
  });

  it("returns null when this computer has not registered yet", async () => {
    const { machineIdForFingerprint } = await import("./transport");
    expect(machineIdForFingerprint([row("mine", "fp-1")], "fp-2")).toBeNull();
    expect(machineIdForFingerprint([row("mine", "fp-1")], null)).toBeNull();
  });

  it("machineId prefers the adopted server id over the local install UUID", async () => {
    const store = new Map<string, string>([["guild_machine_id", "local-install-uuid"]]);
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    });
    const { machineId, adoptServerMachineId } = await import("./transport");
    expect(machineId()).toBe("local-install-uuid");
    adoptServerMachineId("derived-machine-id");
    expect(machineId()).toBe("derived-machine-id");
    expect(store.get("guild_server_machine_id")).toBe("derived-machine-id");
  });
});
