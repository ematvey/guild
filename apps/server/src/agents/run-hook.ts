// A run's rows open before its first model request: pi-durable asks this
// hook before every request attempt, including one a restart re-drives, so
// the row exists before the request is traced and before any tool call
// reads it. The run's inputs come from `pi.live.run`, which names the run.
// The hook never changes the request.

import { GenerationTask, hook, LiveDoc, type HookRegistration } from "@earendil-works/pi-durable";

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
