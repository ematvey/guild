// The Guild extension: the system-prompt sections the built-in agent runs
// with (the persona/guild section and the combined skills index) and the
// approval gate hook (exec policy + approvals).

import {
  defineExtension,
  type ConversationId,
  type HookRegistration,
  type PromptSection,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { createApprovalGate, type ApprovalGateDeps } from "./approvals.js";
import { createDownloadAttachmentTool } from "./attachment-tools.js";
import { CODING_TOOL_NAMES, type IntegrationGate } from "./integrations.js";
import type { SkillRuntime } from "./skills.js";
import type { AttachmentStore } from "../platform/store/attachments.js";
import type { ObjectStore } from "../platform/s3.js";

/** The built-in persona: names the workspace and says when a user's "you"
 *  means the organization rather than the assistant. */
export function defaultPersona(orgName: string | null | undefined): string {
  const name = orgName?.trim();
  const scope =
    name === undefined || name === ""
      ? 'You are the assistant in an organization\'s Guild workspace. A user\'s "you", "we" or "us" can mean the organization or you; when the question is about the organization\'s product, customers or systems, it means the organization. Ask when it is unclear.'
      : `You are the assistant in ${name}'s Guild workspace. A user's "you", "we" or "us" can mean ${name} or you; when the question is about ${name}'s product, customers or systems, it means ${name}. Ask when it is unclear.`;
  return `${scope} Answer concisely and help with the user's tasks, including software work when asked.`;
}

/** The Guild user a thread belongs to (the chat owner). */
export interface CurrentUser {
  id: string;
  email: string;
  display_name: string | null;
  role: string;
}

/** The workspace identity a thread's system prompt is built from: the org
 *  name (the default persona's subject) and its stored persona override. */
export interface OrgProfile {
  name: string;
  prompt: string | null;
}

/** The current-user line: the Guild account this thread belongs to. Tools
 *  that resolve "me" through their own account (Jira `currentUser()`, a
 *  mailbox) answer for that account's owner, so the prompt names the Guild
 *  user. */
export function renderCurrentUser(user: CurrentUser): string {
  const named = user.display_name !== null && user.display_name.trim() !== "";
  const name = named ? user.display_name!.trim() : user.email;
  return `<current_user name="${escapeAttr(name)}" email="${escapeAttr(user.email)}" />`;
}

/** The organization block: the workspace name the chat runs in. Present for
 *  every persona, so an org override keeps the current name without
 *  restating it in its own text. */
export function renderOrganization(name: string): string {
  return `<organization name="${escapeAttr(name)}" />`;
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Renders the request's system prompt body: the persona (org override wins
 *  when non-blank, otherwise the default named for the workspace) plus the
 *  coding-tools sentence. */
export function buildSystemPrompt(orgPrompt: string | null | undefined, orgName?: string | null): string {
  const persona =
    orgPrompt !== null && orgPrompt !== undefined && orgPrompt.trim() !== ""
      ? orgPrompt.trim()
      : defaultPersona(orgName);
  const codingTools = CODING_TOOL_NAMES.map((name) => `\`${name}\``).join(", ");
  return `${persona} Coding tools — ${codingTools} — are called directly. Integration and MCP tools run on the Guild server through the codemode tool: write JavaScript that calls \`tools.<name>\`, and \`tools.thread_history\`/\`tools.thread_search\` as nested calls. Inspect and change files with the coding tools before answering anything that could be about files.`;
}

/** The codemode usage notes: what the shipped tool description leaves easy
 *  to misread — the discovery helpers are sandbox GLOBALS, not members of
 *  `tools`, and weaker models generalize `tools.<name>` onto them. */
export const CODEMODE_NOTES_SECTION_TEXT = [
  "Codemode rules:",
  '- `searchTools`, `ALL_TOOLS`, `describeTool`, `describeNamespace`, `store`, `load`, `text`, `image`, `console`, and `exit` are sandbox globals. Call them bare (`await searchTools("query")`), NEVER as `tools.searchTools` — only the conversation\'s real tools live on `tools`.',
  "- Coding tools are called directly. Integration, MCP and thread-history tools are script-only: reach them through `codemode` scripts, never as direct calls.",
  "- The `code` parameter is the raw script body: pure JavaScript only, never wrapped in a code fence or quotes, and no prose or explanations inside it.",
  '- Tool arguments are always ONE object per the tool\'s declaration: `await tools.bash({ command: "pwd" })`, never a bare string or number.',
  '- There is NO sleep, timer, or delay mechanism in the sandbox — never busy-wait on a clock. Pace calls with sequential awaits and split long work across several codemode calls; a script that would run past ~60s should raise the timeout via the first line `// @options: {"timeout_ms": 300000}` or be split.',
  "- `store(key, value)` persists only if the script ENDS successfully: a script that throws or times out keeps its tool-call effects but loses its store writes. Re-verify with `load()` instead of assuming.",
  "- No Node and no network: require, process, Buffer, fetch, timers do not exist. All I/O goes through nested tool calls.",
].join("\n");

export interface GuildExtensionDeps extends ApprovalGateDeps {
  /** Org id → the workspace name and the stored persona
   *  (org_kv.assistant_system_prompt); null when the org row is gone. */
  orgProfile(orgId: string): Promise<OrgProfile | null>;
  /** conversationId → org id (the chat mapping). */
  orgOfConversation(conversationId: ConversationId): Promise<string | null>;
  /** conversationId → the chat owner's user (the skills index's install
   *  pins resolve against them, and the prompt's current-user block names
   *  them) — the same chat→row lookup. */
  userOfConversation(conversationId: ConversationId): Promise<CurrentUser | null>;
  /** The thread-history tools (thread_history/thread_search), built by the
   *  runtime over its pool; absent in tests without one. */
  threadTools?: readonly ToolRegistration[];
  /** The integrations chat runtime: the approval gate consults it for
   *  the integration tool envelope (absent: the generic policy applies). */
  integrations?: IntegrationGate;
  /** The skills runtime (read_skill/search_skills/push_skill + the
   *  prompt index section); absent in tests without one. */
  skillRuntime?: SkillRuntime;
  /** The Apps index for one member: the Apps they can open, one line each.
   *  Absent in tests without an App store. */
  appsIndex?(orgId: string, userId: string): Promise<string | null>;
  /** Extra task hooks: the run rows' opener, the workspace conflict
   *  journal, tool tracing. */
  toolHooks?: readonly HookRegistration[];
  /** Chat attachments and their bytes in object storage — the
   *  download_attachment tool; absent in tests without them. */
  attachments?: Pick<AttachmentStore, "reachableFromChat">;
  objects?: Pick<ObjectStore, "get">;
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
      const profile = orgId === null ? null : await deps.orgProfile(orgId);
      const user = await deps.userOfConversation(input.conversationId);
      const blocks = [buildSystemPrompt(profile?.prompt, profile?.name)];
      if (profile !== null) blocks.push(renderOrganization(profile.name));
      if (user !== null) blocks.push(renderCurrentUser(user));
      return blocks.join("\n\n");
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
  const appsSection: PromptSection<ToolRegistration> = {
    key: "apps",
    async render(input) {
      const runtime = deps.appsIndex;
      if (runtime === undefined) return undefined;
      // Only a conversation whose agent has the App tools gets the index.
      if (!input.agent.callable.some((tool) => tool.name === "list_apps")) return undefined;
      const orgId = await deps.orgOfConversation(input.conversationId);
      if (orgId === null) return undefined;
      const user = await deps.userOfConversation(input.conversationId);
      if (user === null) return undefined;
      return (await runtime(orgId, user.id)) ?? undefined;
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
    // Skill tools are direct; thread history is script-only (the agent's
    // own conversations_search/conversation_read are the direct surface).
    tools: [
      ...(deps.skillRuntime === undefined ? [] : deps.skillRuntime.tools()),
      ...(deps.threadTools ?? []).map(toolsOnlyCaller),
      ...(deps.attachments === undefined || deps.objects === undefined
        ? []
        : [
            createDownloadAttachmentTool({
              attachments: deps.attachments,
              objects: deps.objects,
              chatOfConversation: deps.chatOfConversation,
              orgOfConversation: deps.orgOfConversation,
            }),
          ]),
    ],
    sections: [section, skillsSection, appsSection, codemodeNotes],
    hooks: [createApprovalGate(deps), ...(deps.toolHooks ?? [])],
  });
}
