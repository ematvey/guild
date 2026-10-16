// The Guild extension: the system-prompt sections the built-in agent runs
// with (the persona/guild section and the combined skills index) and the
// approval gate hook (the M4 exec-policy + approvals lane).

import { defineExtension, type ConversationId, type PromptSection, type ToolRegistration } from "@earendil-works/pi-durable";
import { createApprovalGate, type ApprovalGateDeps } from "./approvals.js";
import type { IntegrationGate } from "./integrations.js";
import type { SkillRuntime } from "./skills.js";

export const ASSISTANT_PROMPT_KEY = "assistant_system_prompt";

export const DEFAULT_PERSONA =
  "You are a helpful assistant. Answer concisely and help with the user's tasks, including software work when asked.";

/** Renders the request's system prompt body: the persona (org override wins
 *  when non-blank) plus the coding-tools sentence. */
export function buildSystemPrompt(orgPrompt: string | null | undefined): string {
  const persona = orgPrompt !== null && orgPrompt !== undefined && orgPrompt.trim() !== "" ? orgPrompt.trim() : DEFAULT_PERSONA;
  return `${persona} Every tool runs on the Guild server through the codemode tool: write JavaScript that calls \`tools.read\`, \`tools.write\`, \`tools.edit\`, \`tools.bash\`, \`tools.thread_history\`, \`tools.thread_search\`, and the skill/MCP tools as nested calls. Inspect and change files with scripts before answering anything that could be about files.`;
}

/** The codemode usage notes: what the shipped tool description leaves easy
 *  to misread — the discovery helpers are sandbox GLOBALS, not members of
 *  `tools`, and weaker models generalize `tools.<name>` onto them. */
export const CODEMODE_NOTES_SECTION_TEXT = [
  "Codemode rules:",
  "- `searchTools`, `ALL_TOOLS`, `describeTool`, `describeNamespace`, `store`, `load`, `text`, `image`, `console`, and `exit` are sandbox globals. Call them bare (`await searchTools(\"query\")`), NEVER as `tools.searchTools` — only the conversation's real tools live on `tools`.",
  "- Every real tool is script-only: direct calls are not offered to you, so always act through `codemode` scripts.",
  "- The `code` parameter is the raw script body: pure JavaScript only, never wrapped in a code fence or quotes, and no prose or explanations inside it.",
  "- Tool arguments are always ONE object per the tool's declaration: `await tools.bash({ command: \"pwd\" })`, never a bare string or number.",
  "- There is NO sleep, timer, or delay mechanism in the sandbox — never busy-wait on a clock. Pace calls with sequential awaits and split long work across several codemode calls; a script that would run past ~60s should raise the timeout via the first line `// @options: {\"timeout_ms\": 300000}` or be split.",
  "- `store(key, value)` persists only if the script ENDS successfully: a script that throws or times out keeps its tool-call effects but loses its store writes. Re-verify with `load()` instead of assuming.",
  "- No Node and no network: require, process, Buffer, fetch, timers do not exist. All I/O goes through nested tool calls.",
].join("\n");

export interface GuildExtensionDeps extends ApprovalGateDeps {
  /** Org id → stored persona lookup (org_kv.assistant_system_prompt). */
  orgPrompt(orgId: string): Promise<string | null>;
  /** conversationId → org id (the chat mapping). */
  orgOfConversation(conversationId: ConversationId): Promise<string | null>;
  /** conversationId → the chat owner's user (the skills index's install
   *  pins resolve against them) — the same chat→row lookup. */
  userOfConversation(conversationId: ConversationId): Promise<{ id: string } | null>;
  /** The thread-history tools (thread_history/thread_search), built by the
   *  runtime over its pool; absent in tests without one. */
  threadTools?: readonly ToolRegistration[];
  /** The integrations chat runtime (M8): the approval gate consults it for
   *  the integration tool envelope (absent: the generic policy applies). */
  integrations?: IntegrationGate;
  /** The skills runtime (read_skill/search_skills/push_skill + the Task 6
   *  prompt index section); absent in tests without one. */
  skillRuntime?: SkillRuntime;
}

/** Codemode-only exposure: tools the model must not see directly become
 *  script-callable (`callers: ["tools"]`) — they stay in the registry (the
 *  codemode section lists them and nested script calls run them) but are
 *  never offered as active model tools. */
export function toolsOnlyCaller<T extends ToolRegistration>(tool: T): T {
  return tool.callers === undefined ? { ...tool, callers: ["tools"] } : tool;
}

export function createGuildExtension(deps: GuildExtensionDeps) {
  const section: PromptSection<ToolRegistration> = {
    key: "guild",
    async render(input) {
      const orgId = await deps.orgOfConversation(input.conversationId);
      const prompt = orgId === null ? null : await deps.orgPrompt(orgId);
      return buildSystemPrompt(prompt);
    },
  };
  const skillsSection: PromptSection<ToolRegistration> = {
    key: "skills",
    async render(input) {
      const runtime = deps.skillRuntime;
      if (runtime === undefined) return undefined;
      const orgId = await deps.orgOfConversation(input.conversationId);
      if (orgId === null) return undefined;
      const user = await deps.userOfConversation(input.conversationId);
      if (user === null) return undefined;
      const rendered = await runtime.indexSection(orgId, user.id, runtime.stashedIndex(Number(input.conversationId)));
      return rendered ?? undefined;
    },
  };
  const codemodeNotes: PromptSection<ToolRegistration> = {
    key: "codemode-notes",
    async render() {
      return CODEMODE_NOTES_SECTION_TEXT;
    },
  };
  return defineExtension({
    name: "guild",
    tools: [...(deps.skillRuntime === undefined ? [] : deps.skillRuntime.tools()), ...(deps.threadTools ?? [])].map(
      toolsOnlyCaller,
    ),
    sections: [section, skillsSection, codemodeNotes],
    hooks: [createApprovalGate(deps)],
  });
}
