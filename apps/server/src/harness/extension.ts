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
  return `${persona} You have tools (read, write, edit, bash) that execute on the Guild server. Use them to inspect and change files before answering anything that could be about files.`;
}

export interface GuildExtensionDeps extends ApprovalGateDeps {
  /** Org id → stored persona lookup (org_kv.assistant_system_prompt). */
  orgPrompt(orgId: string): Promise<string | null>;
  /** conversationId → org id (the chat mapping). */
  orgOfConversation(conversationId: ConversationId): Promise<string | null>;
  /** conversationId → the chat owner's user (the skills index's install
   *  pins resolve against them) — the same chat→row lookup. */
  userOfConversation(conversationId: ConversationId): Promise<{ id: string } | null>;
  /** The integrations chat runtime (M8): the approval gate consults it for
   *  the integration tool envelope (absent: the generic policy applies). */
  integrations?: IntegrationGate;
  /** The skills runtime (read_skill/search_skills/push_skill + the Task 6
   *  prompt index section); absent in tests without one. */
  skillRuntime?: SkillRuntime;
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
  return defineExtension({
    name: "guild",
    tools: deps.skillRuntime === undefined ? [] : deps.skillRuntime.tools(),
    sections: [section, skillsSection],
    hooks: [createApprovalGate(deps)],
  });
}
