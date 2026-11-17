// The App tools: an agent discovers the Apps its member sees, reads one with
// its page, shares one, and runs a data function as the member. Pure over
// fake stores and a temporary workspace.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createAppCallGate,
  createAppTools,
  MAX_CALL_APP_RESULT_CHARS,
  renderAppsIndex,
  type AppToolsContext,
} from "../../agents/app-tools.js";
import type { AppRow } from "../../platform/store/apps.js";
import type { AccessEntry, AccessInput } from "../../platform/store/access.js";
import type { AppFunction } from "../../platform/domain/app-functions.js";
import { ApiError } from "../../platform/errors.js";
import { agentWorkspaceDir } from "../../agents/workspace-config.js";
import type { Agent } from "../../agents/types.js";

const ORG = "11111111-1111-4111-8111-111111111111";
const APP = "22222222-2222-4222-8222-222222222222";
const OTHER_APP = "33333333-3333-4333-8333-333333333333";
const MEMBER = "44444444-4444-4444-8444-444444444444";
const AGENT = "55555555-5555-4555-8555-555555555555";

const searchDeals: AppFunction = {
  name: "deals_by_stage",
  description: "Deals in one stage",
  integration: "hubspot",
  tool: "hubspot_search_deals",
  args: { filters: [{ property: "dealstage", value: { $param: "stage" } }], limit: 100 },
  params: { stage: { type: "string", enum: ["won", "lost", "open"], default: "open" } },
};

const createDeal: AppFunction = {
  name: "create_deal",
  description: "Create one deal",
  integration: "hubspot",
  tool: "hubspot_create_deal",
  args: { name: { $param: "name" } },
  params: { name: { type: "string", required: true } },
};

function appRow(overrides: Partial<AppRow> = {}): AppRow {
  return {
    id: APP,
    org_id: ORG,
    owner_user_id: MEMBER,
    owner_label: "Ada",
    agent_id: null,
    agent_name: null,
    chat_id: null,
    name: "Pipeline",
    description: "Deals by stage",
    visibility: "private",
    can_edit: true,
    version: 3,
    functions: [searchDeals, createDeal],
    created_at: "2026-11-01T00:00:00Z",
    updated_at: "2026-11-02T00:00:00Z",
    ...overrides,
  };
}

const agent = { id: AGENT, org_id: ORG, name: "Builder" } as Agent;

interface Fakes {
  rows: Map<string, AppRow>;
  written: AccessInput[] | null;
  calls: { appId: string; fn: string; args: Record<string, unknown> }[];
  gate: (fn: AppFunction) => { ok: boolean; class: string | null; alwaysAsk: boolean; reason: string | null };
}

function context(root: string, fakes: Fakes): AppToolsContext {
  return {
    apps: {
      listVisible: async (_orgId, userIds) => new Map(userIds.map((userId) => [userId, [...fakes.rows.values()]])),
      getVisible: async (_orgId, id) => {
        const row = fakes.rows.get(id);
        if (row === undefined) throw ApiError.notFound("no such app");
        return row;
      },
      page: async () => ({ html: "<html><body>pipeline</body></html>", sha256: "abc123" }),
    },
    access: {
      entries: async (): Promise<AccessEntry[]> =>
        fakes.written === null
          ? [{ subject_kind: "org", subject_id: null, subject_label: "Everyone in the org", level: "read" }]
          : fakes.written.map((entry) => ({
              ...entry,
              subject_label: entry.subject_kind === "org" ? "Everyone in the org" : "A team",
            })),
      replace: async (_orgId, _kind, _id, entries) => {
        fakes.written = [...entries];
      },
    },
    agent,
    chatId: "chat-1",
    userId: MEMBER,
    userRole: "member",
    userEmail: "ada@example.test",
    workspaceRoot: root,
    functionGate: async (_orgId, _userId, fn) => fakes.gate(fn),
    callFunction: async ({ appId, fn, args }) => {
      fakes.calls.push({ appId, fn: fn.name, args });
      return { ok: true, content: '{"rows":2}', meta: null };
    },
  };
}

function tool(tools: ReturnType<typeof createAppTools>, name: string) {
  const found = tools.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`no tool ${name}`);
  return found;
}

const run = (tools: ReturnType<typeof createAppTools>, name: string, args: unknown) =>
  tool(tools, name).execute(args as never, {} as never, {} as never);

let root: string;
let fakes: Fakes;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "guild-app-tools-"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

function reset(): void {
  fakes = {
    rows: new Map([
      [APP, appRow()],
      [OTHER_APP, appRow({ id: OTHER_APP, name: "Sales board", can_edit: false, functions: [searchDeals] })],
    ]),
    written: null,
    calls: [],
    gate: (fn) =>
      fn.name === "create_deal"
        ? { ok: true, class: "write", alwaysAsk: false, reason: null }
        : { ok: true, class: "read", alwaysAsk: false, reason: null },
  };
}

describe("list_apps", () => {
  it("lists the Apps the member sees, with can_edit and the function names", async () => {
    reset();
    const result = (await run(createAppTools(context(root, fakes)), "list_apps", {})) as {
      structuredOutput: { apps: { id: string; name: string; can_edit: boolean; functions: { name: string }[] }[] };
    };
    expect(result.structuredOutput.apps.map((row) => row.id)).toEqual([APP, OTHER_APP]);
    expect(result.structuredOutput.apps[0]!.functions.map((fn) => fn.name)).toEqual(["deals_by_stage", "create_deal"]);
    expect(result.structuredOutput.apps[1]!.can_edit).toBe(false);
  });

  it("keeps only the Apps a query matches", async () => {
    reset();
    const result = (await run(createAppTools(context(root, fakes)), "list_apps", { query: "sales" })) as {
      structuredOutput: { apps: { id: string }[] };
    };
    expect(result.structuredOutput.apps.map((row) => row.id)).toEqual([OTHER_APP]);
  });
});

describe("read_app", () => {
  it("writes the page into the workspace and reports the functions", async () => {
    reset();
    const result = (await run(createAppTools(context(root, fakes)), "read_app", { app_id: APP })) as {
      structuredOutput: {
        app: { name: string; version: number };
        access: { subject_kind: string }[];
        functions: { name: string; gate: { class: string | null } }[];
        page: { path: string; bytes: number; sha256: string };
      };
    };
    const out = result.structuredOutput;
    expect(out.app).toMatchObject({ name: "Pipeline", version: 3 });
    expect(out.access[0]!.subject_kind).toBe("org");
    expect(out.functions.map((fn) => fn.name)).toEqual(["deals_by_stage", "create_deal"]);
    expect(out.functions[1]!.gate.class).toBe("write");
    const html = await readFile(path.join(agentWorkspaceDir(root, ORG, AGENT), out.page.path), "utf8");
    expect(html).toContain("pipeline");
    expect(out.page.sha256).toBe("abc123");
  });

  it("skips the page when page is false", async () => {
    reset();
    const result = (await run(createAppTools(context(root, fakes)), "read_app", { app_id: APP, page: false })) as {
      structuredOutput: { page: unknown };
    };
    expect(result.structuredOutput.page).toBeNull();
  });

  it("answers a tool error for an App the member cannot see", async () => {
    reset();
    const result = (await run(createAppTools(context(root, fakes)), "read_app", { app_id: "not-an-id" })) as {
      output: { text: string }[];
      isError?: boolean;
    };
    expect(result.isError).toBe(true);
    expect(result.output[0]!.text).toContain("app_id must be an App's id");
  });
});

describe("set_app_access", () => {
  it("refuses an App the member cannot edit", async () => {
    reset();
    const result = (await run(createAppTools(context(root, fakes)), "set_app_access", {
      app_id: OTHER_APP,
      entries: [{ subject_kind: "org", level: "read" }],
    })) as { output: { text: string }[]; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(fakes.written).toBeNull();
  });

  it("replaces the list and returns the stored entries", async () => {
    reset();
    const result = (await run(createAppTools(context(root, fakes)), "set_app_access", {
      app_id: APP,
      entries: [
        { subject_kind: "org", level: "read" },
        { subject_kind: "team", subject_id: "66666666-6666-4666-8666-666666666666", level: "edit" },
      ],
    })) as { structuredOutput: { entries: { subject_kind: string }[] } };
    expect(fakes.written).toEqual([
      { subject_kind: "org", subject_id: null, level: "read" },
      { subject_kind: "team", subject_id: "66666666-6666-4666-8666-666666666666", level: "edit" },
    ]);
    expect(result.structuredOutput.entries.map((entry) => entry.subject_kind)).toEqual(["org", "team"]);
  });

  it("refuses a named entry without an id", async () => {
    reset();
    const result = (await run(createAppTools(context(root, fakes)), "set_app_access", {
      app_id: APP,
      entries: [{ subject_kind: "user", level: "read" }],
    })) as { isError?: boolean };
    expect(result.isError).toBe(true);
    expect(fakes.written).toBeNull();
  });
});

describe("call_app", () => {
  it("runs a read function as the member with its declared parameters", async () => {
    reset();
    const result = (await run(createAppTools(context(root, fakes)), "call_app", {
      app_id: APP,
      function: "deals_by_stage",
      params: { stage: "won" },
    })) as { structuredOutput: { ok: boolean; content: string } };
    expect(result.structuredOutput).toMatchObject({ ok: true, content: '{"rows":2}' });
    expect(fakes.calls).toEqual([
      { appId: APP, fn: "deals_by_stage", args: { filters: [{ property: "dealstage", value: "won" }], limit: 100 } },
    ]);
  });

  it("refuses an undeclared parameter", async () => {
    reset();
    const result = (await run(createAppTools(context(root, fakes)), "call_app", {
      app_id: APP,
      function: "deals_by_stage",
      params: { stage: "won", limit: 5 },
    })) as { isError?: boolean; output: { text: string }[] };
    expect(result.isError).toBe(true);
    expect(result.output[0]!.text).toContain("no parameter");
    expect(fakes.calls).toEqual([]);
  });

  it("refuses a function the member cannot reach, naming the reason", async () => {
    reset();
    fakes.gate = () => ({ ok: false, class: null, alwaysAsk: false, reason: "this tool is not available to you" });
    const result = (await run(createAppTools(context(root, fakes)), "call_app", {
      app_id: APP,
      function: "deals_by_stage",
    })) as { isError?: boolean; output: { text: string }[] };
    expect(result.isError).toBe(true);
    expect(result.output[0]!.text).toContain("this tool is not available to you");
    expect(fakes.calls).toEqual([]);
  });

  it("names the functions an App has when the name is unknown", async () => {
    reset();
    const result = (await run(createAppTools(context(root, fakes)), "call_app", {
      app_id: APP,
      function: "nope",
    })) as { isError?: boolean; output: { text: string }[] };
    expect(result.isError).toBe(true);
    expect(result.output[0]!.text).toContain("deals_by_stage, create_deal");
  });

  it("reports a failed call as a result, not a throw", async () => {
    reset();
    const ctx = context(root, fakes);
    const failing: AppToolsContext = {
      ...ctx,
      callFunction: async () => ({ ok: false, error: "hubspot answered 500" }),
    };
    const result = (await run(createAppTools(failing), "call_app", {
      app_id: APP,
      function: "deals_by_stage",
    })) as { structuredOutput: { ok: boolean; content: string } };
    expect(result.structuredOutput).toMatchObject({ ok: false, content: "hubspot answered 500" });
  });

  it("cuts a result longer than the cap and says so", async () => {
    reset();
    const ctx = context(root, fakes);
    const long: AppToolsContext = {
      ...ctx,
      callFunction: async () => ({ ok: true, content: "x".repeat(MAX_CALL_APP_RESULT_CHARS + 10), meta: null }),
    };
    const result = (await run(createAppTools(long), "call_app", {
      app_id: APP,
      function: "deals_by_stage",
    })) as { structuredOutput: { content: string } };
    expect(result.structuredOutput.content).toContain("was cut");
  });
});

describe("createAppCallGate", () => {
  const gate = () =>
    createAppCallGate({
      apps: { getVisible: async () => appRow() },
      chats: {
        ownerOf: async () => ({
          org_id: ORG,
          user_id: MEMBER,
          email: "ada@example.test",
          display_name: null,
          role: "member",
        }),
      },
      chatOfConversation: async () => "chat-1",
      functionGate: async (_orgId, _userId, fn) => fakes.gate(fn),
    });
  const call = (fn: string) => ({ id: "call-1", name: "call_app", arguments: { app_id: APP, function: fn } });

  it("lets a read-class function flow", async () => {
    reset();
    expect(await gate().decision(1, call("deals_by_stage") as never)).toBeUndefined();
  });

  it("sends a write-class function to the Thread's approval mode", async () => {
    reset();
    expect(await gate().decision(1, call("create_deal") as never)).toBe("policy");
  });

  it("asks for an always_ask curation, whatever the Thread's mode", async () => {
    reset();
    fakes.gate = (fn) =>
      fn.name === "deals_by_stage"
        ? { ok: true, class: "read", alwaysAsk: true, reason: null }
        : { ok: true, class: "write", alwaysAsk: true, reason: null };
    expect(await gate().decision(1, call("deals_by_stage") as never)).toBe("ask");
  });

  it("ignores a tool that is not call_app", async () => {
    reset();
    expect(await gate().decision(1, { id: "c", name: "bash", arguments: {} } as never)).toBeUndefined();
  });
});

describe("renderAppsIndex", () => {
  it("renders nothing for no Apps", () => {
    expect(renderAppsIndex([])).toBeNull();
  });

  it("names each App with its functions and whether the member may edit it", () => {
    const text = renderAppsIndex([appRow(), appRow({ id: OTHER_APP, name: "Sales board", can_edit: false })])!;
    expect(text).toContain(`id ${APP}`);
    expect(text).toContain("deals_by_stage, create_deal");
    expect(text).toContain("editable by you");
    expect(text).toContain("Sales board");
  });
});
