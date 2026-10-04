// The Guild extension: the system-prompt section the built-in agent runs
// with (crates/server/src/worker/restate.rs build_system_prompt port) and
// the approval gate hook (the M4 exec-policy + approvals lane).

import { defineExtension, type ConversationId, type PromptSection, type ToolRegistration } from "@earendil-works/pi-durable";
import { createApprovalGate, type ApprovalGateDeps } from "./approvals.js";

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
  return defineExtension({
    name: "guild",
    sections: [section],
    hooks: [createApprovalGate(deps)],
  });
}
