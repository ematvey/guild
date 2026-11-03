// The combined skills index section (Task 6): SkillRuntime.indexSection
// renders the section the guild extension's `skills` prompt section emits —
// the stashed client `skills_index` lines first, then the org portion
// (installed with pin/update markers, then uninstalled clipped with the
// (org) marker), the 8192-byte budget with the search_skills overflow line,
// and null only when both halves are empty. Plus the submitTurn plumbing
// (POST /gateway/chat → noteTurnInput) against the full gateway stack.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createGuildExtension, type GuildExtensionDeps } from "../../harness/extension.js";
import { SkillRuntime, type SkillRuntimeDeps } from "../../harness/skills.js";
import { setupGatewayStack, type GatewayStack } from "../support/gateway-stack.js";
import type { GuildRuntime } from "../../harness/runtime.js";

const ORG = "org-1";
const USER = "user-1";
const CTX = {} as Context;

const HEADER = "# Available skills";
const GUIDANCE =
  "When a task matches a skill, read it with read_skill and follow it. read_skill returns the SKILL.md and the additional files the skill ships; if one shows a newer version, ask the user before updating. Each entry names its publisher; read_skill returns the full provenance.";

const SQL_EXPLORER_DESC = "Run the SQL explorer against the analytics cluster.";
const BACKUP_DESC = "Verify nightly backups.";
const RUNBOOK_DESC =
  "Checklist for the first hour of a production incident: page the owner, check the status page, roll back the last deploy.";
const TAILER_DESC = "Tail and summarize service logs.";

const SEARCH = [
  {
    slug: "sql-explorer",
    description: SQL_EXPLORER_DESC,
    latest_version: "v5",
    review_status: "approved",
    publisher: "Dana Levi",
    published_at: "2026-05-12T09:00:00Z",
    owner_kind: "team",
    owner_label: "CSM",
    forked_from: null,
  },
  {
    slug: "backup-tool",
    description: BACKUP_DESC,
    latest_version: "v2",
    review_status: "approved",
    publisher: "Isaac Cohen",
    published_at: "2026-05-10T09:00:00Z",
    owner_kind: "user",
    owner_label: "Isaac Cohen",
    forked_from: null,
  },
  // No publisher known: the line carries no attribution at all.
  { slug: "incident-runbook", description: RUNBOOK_DESC, latest_version: "v4", review_status: "draft" },
  { slug: "log-tailer", description: TAILER_DESC, latest_version: "v1", review_status: "draft" },
];

const INSTALLS = [
  { slug: "sql-explorer", pinned_version: "v3", installed_at: "2026-01-01T00:00:00.000Z" },
  // Unpinned: follows the latest version, so no update note.
  { slug: "backup-tool", pinned_version: null, installed_at: "2026-01-01T00:00:00.000Z" },
];

// The client-assembled index a machine turn sends (client header + its own
// local lines, client format).
const LOCAL_INDEX =
  "\n# Available skills\nWhen a task matches a skill, read its SKILL.md with read_file and follow it.\n" +
  "- demo: Local demo skill (/home/u/.agents/skills/demo/SKILL.md)\n";

interface FakeOptions {
  search?: Array<{ slug: string; description: string; latest_version: string | null; review_status: string }>;
  installs?: Array<{ slug: string; pinned_version: string | null; installed_at: string }>;
  /** The registry search throws (store failure). */
  fail?: boolean;
}

function fakeDeps(options: FakeOptions): SkillRuntimeDeps {
  return {
    log: { warn: () => {} },
    registry: {
      itemControl: async () => null,
      getVersionMeta: async () => null,
      publishGate: async () => {},
      itemVersions: async () => [],
      upsertVersion: async () => {},
      searchSkills: async () => {
        if (options.fail) throw new Error("store down");
        return (options.search ?? []) as never;
      },
    },
    skills: {
      install: async () => {
        throw new Error("not expected in this suite");
      },
      byUserAndSlug: async () => null,
      listForUser: async () => (options.installs ?? []) as never,
    },
    events: {
      emit: async () => {
        throw new Error("not expected in this suite");
      },
    },
    teams: { isMember: async () => false },
    objects: undefined,
    skillReads: undefined,
    chatOfConversation: async () => "chat-1",
    chatOwner: async () => ({ orgId: ORG, userId: USER, role: "member", label: "Member" }),
    executorKind: async () => null,
    conversationEnv: async () => new NodeExecutionEnv({ cwd: "/nonexistent" }),
  };
}

function makeRuntime(deps: SkillRuntimeDeps): SkillRuntime {
  return new SkillRuntime(deps);
}

// ------------------------------------------------------- the combined section

describe("combined skills index section", () => {
  it("renders local lines, installs with pin/update markers, then uninstalled org lines", async () => {
    const runtime = makeRuntime(fakeDeps({ search: SEARCH, installs: INSTALLS }));
    const section = await runtime.indexSection(ORG, USER, LOCAL_INDEX);
    expect(section).toBe(
      [
        HEADER,
        GUIDANCE,
        "- demo: Local demo skill (/home/u/.agents/skills/demo/SKILL.md)",
        `- sql-explorer: ${SQL_EXPLORER_DESC} (installed, pinned v3, update available: v5, by Dana Levi)`,
        `- backup-tool: ${BACKUP_DESC} (installed, latest, by Isaac Cohen)`,
        `- incident-runbook: ${RUNBOOK_DESC} (org)`,
        `- log-tailer: ${TAILER_DESC} (org)`,
      ].join("\n"),
    );
  });

  it("renders the org portion alone when the client sent no index", async () => {
    const runtime = makeRuntime(fakeDeps({ search: SEARCH, installs: INSTALLS }));
    const section = await runtime.indexSection(ORG, USER);
    expect(section).toBe(
      [
        HEADER,
        GUIDANCE,
        `- sql-explorer: ${SQL_EXPLORER_DESC} (installed, pinned v3, update available: v5, by Dana Levi)`,
        `- backup-tool: ${BACKUP_DESC} (installed, latest, by Isaac Cohen)`,
        `- incident-runbook: ${RUNBOOK_DESC} (org)`,
        `- log-tailer: ${TAILER_DESC} (org)`,
      ].join("\n"),
    );
  });

  it("never repeats a slug the local index already lists", async () => {
    const runtime = makeRuntime(fakeDeps({ search: SEARCH, installs: INSTALLS }));
    const local = `${LOCAL_INDEX}- incident-runbook: my local copy (/repo/skills/incident-runbook/SKILL.md)\n`;
    const section = (await runtime.indexSection(ORG, USER, local))!;
    expect(section).toContain("/repo/skills/incident-runbook/SKILL.md");
    // Only the local copy's line carries the slug — the org list skipped it.
    expect(section).not.toMatch(/- incident-runbook:.*\(org\)/);
  });

  it("clips uninstalled descriptions at 120 chars with an ellipsis", async () => {
    const long = "p".repeat(130);
    const runtime = makeRuntime(
      fakeDeps({
        search: [{ slug: "big-skill", description: long, latest_version: "v1", review_status: "draft" }],
      }),
    );
    const section = (await runtime.indexSection(ORG, USER))!;
    expect(section).toContain(`- big-skill: ${"p".repeat(120)}… (org)`);
    expect(section).not.toContain("p".repeat(121));
  });

  it("is null when the org has no skills and no local index", async () => {
    const runtime = makeRuntime(fakeDeps({ search: [] }));
    expect(await runtime.indexSection(ORG, USER)).toBeNull();
  });

  it("is null when the store fails and no local index was stashed", async () => {
    const runtime = makeRuntime(fakeDeps({ fail: true }));
    expect(await runtime.indexSection(ORG, USER)).toBeNull();
  });

  it("renders the local portion alone when the store fails (never blocks the turn)", async () => {
    const runtime = makeRuntime(fakeDeps({ fail: true }));
    const section = (await runtime.indexSection(ORG, USER, LOCAL_INDEX))!;
    expect(section).toBe(
      [HEADER, GUIDANCE, "- demo: Local demo skill (/home/u/.agents/skills/demo/SKILL.md)"].join("\n"),
    );
    expect(section).not.toContain("(org)");
  });

  it("adds the search_skills truncation line when the section is over budget", async () => {
    const items = Array.from({ length: 80 }, (_, i) => ({
      slug: `bulk-skill-${String(i).padStart(2, "0")}`,
      description: "A".repeat(300),
      latest_version: "v1",
      review_status: "draft",
    }));
    const runtime = makeRuntime(fakeDeps({ search: items }));
    const section = (await runtime.indexSection(ORG, USER))!;
    expect(Buffer.byteLength(section, "utf8")).toBeLessThanOrEqual(8192);
    expect(section).toMatch(/\(\d+ more org skills — use search_skills\)/);
    // Early skills stay listed, the dropped tail does not.
    expect(section).toContain("- bulk-skill-00:");
    expect(section).not.toContain("- bulk-skill-79:");
  });
});

// ------------------------------------------------ the guild extension's section

function extensionDeps(skillRuntime: SkillRuntime | undefined, orgId: string | null): GuildExtensionDeps {
  return {
    pool: {} as never,
    threads: {} as never,
    log: { warn: () => {}, info: () => {}, error: () => {} } as never,
    execPolicy: {} as never,
    approvalTimeoutMs: 1000,
    selfBaseUrl: "http://127.0.0.1:1",
    internalKey: null,
    allowShellTools: false,
    chatOfConversation: async () => "chat-1",
    executorKind: async () => null,
    currentModel: async () => null,
    orgProfile: async () => ({ name: "Skill Test Org", prompt: null }),
    orgOfConversation: async () => orgId,
    userOfConversation: async () => ({ id: USER, email: "user-1@example.test", display_name: null, role: "member" }),
    skillRuntime,
  } as unknown as GuildExtensionDeps;
}

describe("guild extension skills section", () => {
  const input = { conversationId: 7 } as never;

  it("renders the combined section through the runtime (stash rides along)", async () => {
    const runtime = makeRuntime(fakeDeps({ search: SEARCH, installs: INSTALLS }));
    runtime.noteTurnInput(7, LOCAL_INDEX);
    const extension = createGuildExtension(extensionDeps(runtime, ORG));
    const section = extension.sections?.find((s) => s.key === "skills");
    expect(section).toBeDefined();
    const rendered = await section!.render(input, CTX);
    expect(rendered).toContain(HEADER);
    expect(rendered).toContain("- demo: Local demo skill");
    expect(rendered).toContain("(installed, pinned v3, update available: v5, by Dana Levi)");
    expect(rendered).toContain("(org)");
  });

  it("renders nothing when the conversation has no org", async () => {
    const runtime = makeRuntime(fakeDeps({ search: SEARCH }));
    const extension = createGuildExtension(extensionDeps(runtime, null));
    const section = extension.sections!.find((s) => s.key === "skills")!;
    expect(await section.render(input, CTX)).toBeUndefined();
  });

  it("renders nothing without a skill runtime", async () => {
    const extension = createGuildExtension(extensionDeps(undefined, ORG));
    const section = extension.sections!.find((s) => s.key === "skills")!;
    expect(await section.render(input, CTX)).toBeUndefined();
  });

  it("carries the skill tools on the extension", () => {
    const runtime = makeRuntime(fakeDeps({}));
    const extension = createGuildExtension(extensionDeps(runtime, ORG));
    expect(extension.tools?.map((t) => t.name)).toEqual(["read_skill", "search_skills", "push_skill"]);
  });
});

// --------------------------------------------------- turn plumbing (full stack)

describe("submitTurn skills_index plumbing", () => {
  let stack: GatewayStack;
  let memberToken: string;
  let runtime: GuildRuntime;
  const sandboxRoot = mkdtempSync(path.join(tmpdir(), "guild-skills-index-"));

  beforeAll(async () => {
    stack = await setupGatewayStack({ GUILD_SANDBOX_ROOT: sandboxRoot }, { dbPrefix: "guild_skills_index_test" });
    await stack.routeModel("GLM-Test-Model");
    memberToken = stack.memberToken;
    runtime = (stack.env.app as unknown as { platform: { runtime: GuildRuntime } }).platform.runtime;
  }, 60_000);

  afterAll(async () => {
    await stack.close();
  }, 30_000);

  const auth = (token: string): Record<string, string> => ({
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  });

  async function createChat(title: string): Promise<string> {
    const res = await stack.env.app.inject({
      method: "POST",
      url: "/api/v1/chats",
      headers: auth(memberToken),
      payload: { title },
    });
    expect(res.statusCode).toBe(200);
    return (JSON.parse(res.body) as { id: string }).id;
  }

  it("forwards the request's skills_index into the runtime's stash", async () => {
    const chatId = await createChat("skills-index-plumbing");
    const sent = "# Available skills\n- local-skill: A local skill (/machine/.agents/skills/local-skill/SKILL.md)\n";
    const res = await stack.env.app.inject({
      method: "POST",
      url: "/api/v1/gateway/chat",
      headers: auth(memberToken),
      payload: {
        chat_id: chatId,
        model: "GLM-Test-Model",
        messages: [{ role: "user", content: "hello" }],
        skills_index: sent,
      },
    });
    expect(res.statusCode).toBe(200);
    const conversationId = runtime.conversationIdForChat(chatId);
    expect(conversationId).toBeDefined();
    expect(runtime.skillsRuntime.stashedIndex(conversationId!)).toBe(sent);
  });

  it("appends a desktop turn's agents_md to the agent's instructions", async () => {
    const chatId = await createChat("agents-md-plumbing");
    const chain = '<project_instructions path="/repo/AGENTS.md">\nUse pnpm, never npm.\n</project_instructions>';
    const res = await stack.env.app.inject({
      method: "POST",
      url: "/api/v1/gateway/chat",
      headers: auth(memberToken),
      payload: {
        chat_id: chatId,
        model: "GLM-Test-Model",
        messages: [{ role: "user", content: "hello" }],
        agents_md: chain,
      },
    });
    expect(res.statusCode).toBe(200);
    const conversation = await runtime.conversationForChat(chatId);
    const instructions = (await conversation.agent(BACKGROUND_CONTEXT)).instructions ?? "";
    expect(instructions).toContain("<project_context>");
    expect(instructions).toContain("Use pnpm, never npm.");
  });

  it("stashes an empty index for browser turns that send none", async () => {
    const chatId = await createChat("skills-index-empty");
    const res = await stack.env.app.inject({
      method: "POST",
      url: "/api/v1/gateway/chat",
      headers: auth(memberToken),
      payload: { chat_id: chatId, model: "GLM-Test-Model", messages: [{ role: "user", content: "hi" }] },
    });
    expect(res.statusCode).toBe(200);
    const conversationId = runtime.conversationIdForChat(chatId)!;
    expect(runtime.skillsRuntime.stashedIndex(conversationId)).toBe("");
  });
});
