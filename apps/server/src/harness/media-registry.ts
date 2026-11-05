// The registry every extension installs into, wrapped so that no tool result
// puts image bytes into a durable entry: the wrapper spills each image part
// to object storage and leaves a reference in its place (chats/media-ref.ts).
//
// The seam is the install, not the tool list: a tool Guild adds later — an
// integration, an MCP server, a client tool registered per turn — is covered
// without naming it, and a tool that already spilled its own images passes
// through untouched.

import type { Extension, Registry, ToolRegistration } from "@earendil-works/pi-durable";
import type { ToolExecutionResult } from "@earendil-works/pi-durable";
import { spillImageParts, type SpillStores } from "../chats/media-spill.js";

/** What the wrapper needs to name a spill: the tool's chat and org, from the
 *  conversation the call runs in. */
export interface MediaSpillDeps {
  stores: SpillStores;
  /** The chat a conversation belongs to, and its org; null when unmapped
   *  (the in-process test path), where the result rides inline. */
  scopeOf(conversationId: number): Promise<{ orgId: string; chatId: string } | null>;
}

/** One tool, with its result's image parts spilled. */
function spillingTool(tool: ToolRegistration, deps: MediaSpillDeps): ToolRegistration {
  const execute: ToolRegistration["execute"] = async (args, api, context) => {
    const result = (await tool.execute(args, api, context)) as ToolExecutionResult;
    const output = result.output;
    if (output === undefined || !output.some((part) => part.type === "image")) return result;
    const scope = await deps.scopeOf(api.conversationId);
    if (scope === null) return result;
    const { parts } = await spillImageParts(deps.stores, {
      orgId: scope.orgId,
      chatId: scope.chatId,
      callId: api.callId,
      toolName: tool.name,
    }, output);
    return { ...result, output: parts as typeof result.output };
  };
  return { ...tool, execute } as ToolRegistration;
}

function spillingExtension(extension: Extension, deps: MediaSpillDeps): Extension {
  const tools = extension.tools;
  if (tools === undefined || tools.length === 0) return extension;
  return { ...extension, tools: tools.map((tool) => spillingTool(tool, deps)) };
}

/** The install-time wrapper: every extension's tools get the spill. */
export function mediaSpillingRegistry(inner: Registry, deps: MediaSpillDeps): Registry {
  return {
    install: (extension) => inner.install(spillingExtension(extension, deps)),
    uninstall: (extension) => inner.uninstall(extension),
    snapshot: () => inner.snapshot(),
    subscribe: (listener) => inner.subscribe(listener),
  };
}
