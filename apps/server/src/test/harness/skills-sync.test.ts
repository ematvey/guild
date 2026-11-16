// The fleet sync push (Task 8, spec §4): SkillRuntime.syncUser fans the
// user's install list out as `skills.sync_v1` machineRequest pushes over
// the hub — one push per machine row the hub reports live, offline
// machines skipped, per-machine failures logged and never thrown. The
// payload is the full desired state: the machine converges by fetching
// newer bundles and dropping locally-held slugs the list omits (an
// uninstall's row is gone, so absence is the removal signal). The
// connect-time push and the routes' onInstallChange are thin call-throughs
// of this same method (http/ws.ts seam + platform/http/register.ts).

import { describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { SkillRuntime, type SkillRuntimeDeps } from "../../harness/skills.js";
import type { MachineRow } from "../../platform/store/machines.js";

const ORG = "org-1";
const USER = "user-1";
const SELF = "https://guild.example";

interface SyncArgs {
  machineId: string;
  orgId: string;
  op: string;
  payload: unknown;
}

interface Fixture {
  runtime: SkillRuntime;
  warns: string[];
  machines: Array<{ machine_id: string }>;
  online: Set<string>;
  installs: Array<{ slug: string; pinned_version: string; installed_at: string }>;
  metas: Map<
    string,
    {
      bundle_sha256: string | null;
      publisher_label?: string | null;
      published_at?: string | null;
    }
  >;
  calls: SyncArgs[];
  behaviors: Map<string, "ok" | "offline" | "reject">;
}

function makeFixture(options: { selfBaseUrl?: string } = {}): Fixture {
  const fx: Fixture = {
    runtime: undefined as never,
    warns: [],
    machines: [],
    online: new Set(),
    installs: [],
    metas: new Map(),
    calls: [],
    behaviors: new Map(),
  };
  const deps: SkillRuntimeDeps = {
    log: { warn: (m) => fx.warns.push(m) },
    registry: {
      itemControl: async () => null,
      getVersionMeta: async (_orgId, _kind, slug, version) =>
        (fx.metas.get(`${slug}@${version}`) ?? null) as Awaited<
          ReturnType<SkillRuntimeDeps["registry"]["getVersionMeta"]>
        >,
      publishGate: async () => {},
      itemVersions: async () => [],
      upsertVersion: async () => {},
      searchSkills: async () => [],
    },
    skills: {
      install: async () => {
        throw new Error("not used here");
      },
      byUserAndSlug: async () => null,
      listForUser: async () => fx.installs,
    },
    events: {
      emit: async () => {
        throw new Error("not used here");
      },
    },
    teams: { isMember: async () => false },
    objects: undefined,
    skillReads: undefined,
    chatOfConversation: async () => null,
    chatOwner: async () => null,
    conversationEnv: async () => new NodeExecutionEnv({ cwd: "/nonexistent" }),
    machines: { listForUser: async () => fx.machines as MachineRow[] },
    machineOnline: (machineId) => fx.online.has(machineId),
    machineRequest: async (args) => {
      // Recorded synchronously: the pushes are dispatched (not awaited) by
      // syncUser, so the capture is deterministic at await-return time.
      fx.calls.push(args);
      const behavior = fx.behaviors.get(args.machineId) ?? "ok";
      if (behavior === "offline") return { ok: false, error: { kind: "offline" } };
      if (behavior === "reject") throw new Error("socket blew up");
      return { ok: true, value: null };
    },
    ...(options.selfBaseUrl !== undefined ? { selfBaseUrl: options.selfBaseUrl } : {}),
  };
  fx.runtime = new SkillRuntime(deps);
  return fx;
}

/** Drains the fire-and-forget push chains: the in-memory fixture settles
 *  them in microtasks, and the next macrotask turn runs after all of them. */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("skills syncUser", () => {
  it("pushes the full desired state to every online machine, skipping offline ones", async () => {
    const fx = makeFixture({ selfBaseUrl: SELF });
    fx.machines = [{ machine_id: "m-online-1" }, { machine_id: "m-offline" }, { machine_id: "m-online-2" }];
    fx.online = new Set(["m-online-1", "m-online-2"]);
    fx.installs = [
      { slug: "hello", pinned_version: "v2", installed_at: "2026-10-13T00:00:00Z" },
      { slug: "other", pinned_version: "v1", installed_at: "2026-10-13T00:00:00Z" },
    ];
    fx.metas.set("hello@v2", {
      bundle_sha256: "sha-hello",
      publisher_label: "Dana Levi",
      published_at: "2026-05-12T09:00:00Z",
    });
    fx.metas.set("other@v1", { bundle_sha256: "sha-other" });

    await fx.runtime.syncUser(ORG, USER);

    expect(fx.calls.map((c) => c.machineId)).toEqual(["m-online-1", "m-online-2"]);
    const payload = fx.calls[0]!.payload as {
      skills: Array<{
        slug: string;
        version: string;
        bundle_sha256: string;
        publisher?: string;
        published_at?: string;
        url: string;
      }>;
    };
    // The version's provenance rides the payload into the machine's
    // sidecar, so the agent can name the author without the server.
    expect(payload.skills).toEqual([
      {
        slug: "hello",
        version: "v2",
        bundle_sha256: "sha-hello",
        publisher: "Dana Levi",
        published_at: "2026-05-12T09:00:00Z",
        url: `${SELF}/api/v1/registry/skill/hello/v2/bundle`,
      },
      {
        slug: "other",
        version: "v1",
        bundle_sha256: "sha-other",
        url: `${SELF}/api/v1/registry/skill/other/v1/bundle`,
      },
    ]);
    for (const call of fx.calls) {
      expect(call.orgId).toBe(ORG);
      expect(call.op).toBe("skills.sync_v1");
    }
    await flush();
    expect(fx.warns).toEqual([]);
  });

  it("omits url without selfBaseUrl and drops entries whose version row is gone", async () => {
    const fx = makeFixture();
    fx.machines = [{ machine_id: "m-1" }];
    fx.online = new Set(["m-1"]);
    fx.installs = [
      { slug: "present", pinned_version: "v1", installed_at: "2026-10-13T00:00:00Z" },
      { slug: "vanished", pinned_version: "v9", installed_at: "2026-10-13T00:00:00Z" },
    ];
    fx.metas.set("present@v1", { bundle_sha256: null });

    await fx.runtime.syncUser(ORG, USER);

    expect(fx.calls).toHaveLength(1);
    const payload = fx.calls[0]!.payload as { skills: Array<{ slug: string; url?: string }> };
    expect(payload.skills).toEqual([{ slug: "present", version: "v1", bundle_sha256: "" }]);
    expect(fx.warns.some((w) => w.includes("vanished"))).toBe(true);
  });

  it("does not throw or block on a failed push and keeps the other machines", async () => {
    const fx = makeFixture({ selfBaseUrl: SELF });
    fx.machines = [{ machine_id: "m-bad" }, { machine_id: "m-good" }];
    fx.online = new Set(["m-bad", "m-good"]);
    fx.installs = [{ slug: "hello", pinned_version: "v1", installed_at: "2026-10-13T00:00:00Z" }];
    fx.metas.set("hello@v1", { bundle_sha256: "sha-hello" });
    fx.behaviors.set("m-bad", "reject");

    await fx.runtime.syncUser(ORG, USER);

    // Fire-and-forget: both pushes were dispatched without awaiting them.
    expect(fx.calls.map((c) => c.machineId)).toEqual(["m-bad", "m-good"]);
    await flush();
    expect(fx.warns.some((w) => w.includes("m-bad") && w.includes("socket blew up"))).toBe(true);
  });

  it("logs an offline reply as a per-machine failure", async () => {
    const fx = makeFixture({ selfBaseUrl: SELF });
    fx.machines = [{ machine_id: "m-gone" }];
    fx.online = new Set(["m-gone"]);
    fx.installs = [{ slug: "hello", pinned_version: "v1", installed_at: "2026-10-13T00:00:00Z" }];
    fx.metas.set("hello@v1", { bundle_sha256: "sha-hello" });
    fx.behaviors.set("m-gone", "offline");

    await fx.runtime.syncUser(ORG, USER);

    expect(fx.calls).toHaveLength(1);
    await flush();
    expect(fx.warns.some((w) => w.includes("m-gone") && w.includes("offline"))).toBe(true);
  });

  it("is a no-op without the machine store", async () => {
    const fx = makeFixture({ selfBaseUrl: SELF });
    fx.machines = [{ machine_id: "m-1" }];
    fx.installs = [{ slug: "hello", pinned_version: "v1", installed_at: "2026-10-13T00:00:00Z" }];
    const runtime = new SkillRuntime({
      log: { warn: (m) => fx.warns.push(m) },
      registry: {
        itemControl: async () => null,
        getVersionMeta: async () => null,
        publishGate: async () => {},
        itemVersions: async () => [],
        upsertVersion: async () => {},
        searchSkills: async () => [],
      },
      skills: {
        install: async () => {
          throw new Error("not used here");
        },
        byUserAndSlug: async () => null,
        listForUser: async () => fx.installs,
      },
      events: {
        emit: async () => {
          throw new Error("not used here");
        },
      },
      teams: { isMember: async () => false },
      objects: undefined,
      skillReads: undefined,
      chatOfConversation: async () => null,
      chatOwner: async () => null,
        conversationEnv: async () => new NodeExecutionEnv({ cwd: "/nonexistent" }),
    });

    await runtime.syncUser(ORG, USER);

    expect(fx.calls).toEqual([]);
    expect(fx.warns).toEqual([]);
  });

  it("logs a machine-list failure and pushes nothing", async () => {
    const fx = makeFixture({ selfBaseUrl: SELF });
    fx.machines = [{ machine_id: "m-1" }];
    fx.installs = [{ slug: "hello", pinned_version: "v1", installed_at: "2026-10-13T00:00:00Z" }];
    const failing = new SkillRuntime({
      log: { warn: (m) => fx.warns.push(m) },
      registry: {
        itemControl: async () => null,
        getVersionMeta: async () => null,
        publishGate: async () => {},
        itemVersions: async () => [],
        upsertVersion: async () => {},
        searchSkills: async () => [],
      },
      skills: {
        install: async () => {
          throw new Error("not used here");
        },
        byUserAndSlug: async () => null,
        listForUser: async () => fx.installs,
      },
      events: {
        emit: async () => {
          throw new Error("not used here");
        },
      },
      teams: { isMember: async () => false },
      objects: undefined,
      skillReads: undefined,
      chatOfConversation: async () => null,
      chatOwner: async () => null,
        conversationEnv: async () => new NodeExecutionEnv({ cwd: "/nonexistent" }),
      machines: {
        listForUser: async () => {
          throw new Error("db down");
        },
      },
      machineOnline: () => true,
      machineRequest: async (args) => {
        fx.calls.push(args);
        return { ok: true, value: null };
      },
    });

    await failing.syncUser(ORG, USER);

    expect(fx.calls).toEqual([]);
    expect(fx.warns.some((w) => w.includes("machine list failed"))).toBe(true);
  });

  it("pushes nothing when the user has no machines", async () => {
    const fx = makeFixture({ selfBaseUrl: SELF });
    fx.installs = [{ slug: "hello", pinned_version: "v1", installed_at: "2026-10-13T00:00:00Z" }];
    fx.metas.set("hello@v1", { bundle_sha256: "sha-hello" });

    await fx.runtime.syncUser(ORG, USER);

    expect(fx.calls).toEqual([]);
  });

  it("zero installs is still a payload (the machine's pull serves it — the empty converge frame)", async () => {
    const fx = makeFixture({ selfBaseUrl: SELF });
    fx.machines = [{ machine_id: "m-1" }];
    fx.online = new Set(["m-1"]);

    const payload = await fx.runtime.syncPayload(ORG, USER);

    expect(payload).toEqual({ skills: [] });
    expect(fx.warns).toEqual([]);
  });

  it("a change trigger with zero installs (final uninstall) pushes the empty desired-state frame", async () => {
    const fx = makeFixture({ selfBaseUrl: SELF });
    fx.machines = [{ machine_id: "m-1" }];
    fx.online = new Set(["m-1"]);

    await fx.runtime.syncUser(ORG, USER);

    expect(fx.calls).toHaveLength(1);
    expect(fx.calls[0]!.machineId).toBe("m-1");
    expect(fx.calls[0]!.orgId).toBe(ORG);
    expect(fx.calls[0]!.op).toBe("skills.sync_v1");
    expect(fx.calls[0]!.payload).toEqual({ skills: [] });
    await flush();
    expect(fx.warns).toEqual([]);
  });
});
