import { coordinatorAgentForChat } from "./store/coordination.js";
import { coordinationSettings } from "./coordination.js";
import type { PlatformPool } from "../platform/db.js";
import type { AgentStore } from "./store.js";
import { guildProviderId } from "../harness/models.js";
// A run's rows open before its first model request: pi-durable asks this
// hook before every request attempt, including one a restart re-drives, so
// the row exists before the request is traced and before any tool call
// reads it. The run's inputs come from `pi.live.run`, which names the run.
// The hook never changes the request.

import { GenerationTask, CompactionTask, hook, LiveDoc, type HookRegistration } from "@earendil-works/pi-durable";

export function createRunHook(
  runStart: (chatId: string, inputs: readonly number[]) => Promise<void>,
  chatOfConversation: (conversationId: number) => Promise<string | null>,
): HookRegistration {
  return hook(GenerationTask, {
    async beforeRequest(_request, api, context) {
      const chatId = await chatOfConversation(Number(api.conversationId));
      if (chatId === null) return undefined;
      const run = (await api.snapshot(LiveDoc, api.conversationId, context))?.run;
      if (run === undefined) return undefined;
      await runStart(chatId, run.inputs.map(Number));
      return undefined;
    },
  });
}

/** Role-specific summarization preserves attribution and live coordination references. */
export function createCoordinationCompactionHook(
  pool: PlatformPool,
  store: AgentStore,
  chatOf: (id: number) => Promise<string | null>,
): HookRegistration {
  return hook(CompactionTask, {
    async beforeCompact(compaction, api, context) {
      const chatId = await chatOf(Number(api.conversationId));
      if (chatId === null) return undefined;
      const row = (await coordinatorAgentForChat<{ agent_id: string }>(pool, [chatId])).rows[0];
      if (row === undefined) return undefined;
      const agent = await store.fetchAgent(row.agent_id);
      const model = api.models.getModel(guildProviderId(agent.org_id), coordinationSettings(agent).compaction_model);
      if (model === undefined) throw new Error("Compaction model is unavailable");
      const response = await api.models.completeSimple(
        model,
        {
          systemPrompt:
            "Summarize the older context of a persistent coordinator. Preserve member identities, source/input/message/thread IDs, causal links, commitments, pending worker work, reporting preferences, current decisions and future wake-up reasons exactly. Distinguish requests from passive observations. Keep concise; do not invent completed work. Newer context remains separately available.",
          messages: [{ role: "user", content: JSON.stringify(compaction.messages), timestamp: Date.now() }],
        },
        { maxTokens: 4096, signal: context.abortSignal },
      );
      if (response.stopReason === "error" || response.stopReason === "aborted")
        throw new Error("Coordinator compaction failed");
      const summary = response.content
        .filter((x) => x.type === "text")
        .map((x) => x.text)
        .join("\n");
      if (summary.trim() === "") throw new Error("Coordinator compaction returned no summary");
      return { summary };
    },
  });
}
