// The agent's own tool set: the four coding tools, renamed and bound to the
// agent sandbox instead of the conversation's env. A project-bound chat runs
// `read`/`write`/`edit`/`bash` on the user's machine, so the agent reaches
// its workspace through these names.

import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-durable/tools";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { JsonValue } from "@earendil-works/chord";
import type { ToolExecutionApi, ToolRegistration } from "@earendil-works/pi-durable";

/** The agent-sandbox tools, in prompt order. */
export const AGENT_TOOL_NAMES = ["agent_read", "agent_write", "agent_edit", "agent_bash"] as const;

/** The tool API with `env` replaced: pi's tools resolve their environment
 *  through `api.env`, so this is the whole binding. */
function withEnv<T extends JsonValue>(api: ToolExecutionApi<T>, env: ExecutionEnv): ToolExecutionApi<T> {
  return new Proxy(api, {
    get(target, prop, receiver) {
      if (prop === "env") return env;
      return Reflect.get(target, prop, receiver);
    },
  });
}

/** The machine set: the same four tools under their plain names, with the
 *  environment named in the description. Installed per chat when the chat is
 *  bound to a project; the tool API keeps the conversation env, which is the
 *  machine. */
export function createMachineTools(): ToolRegistration[] {
  return [createReadTool(), createWriteTool(), createEditTool(), createBashTool()].map((tool) => ({
    ...tool,
    description: `${tool.description} Runs on the user's machine, in the bound project folder.`,
  })) as ToolRegistration[];
}

/** The four coding tools, renamed and bound to `env`. The descriptions say
 *  which environment they act on, so the model can tell them from the
 *  machine-bound `read`/`write`/`edit`/`bash`. */
export function createAgentWorkspaceTools(env: ExecutionEnv): ToolRegistration[] {
  const pairs: ReadonlyArray<[string, ToolRegistration]> = [
    ["agent_read", createReadTool()],
    ["agent_write", createWriteTool()],
    ["agent_edit", createEditTool()],
    ["agent_bash", createBashTool()],
  ];
  return pairs.map(([name, tool]) => ({
    ...tool,
    name,
    description: `${tool.description} Runs in your own agent workspace (the sandbox), not on the user's machine.`,
    execute: (args, api, context) => tool.execute(args, withEnv(api, env), context),
  })) as ToolRegistration[];
}


/** The direct tool surface for an agent: its allowlist narrows the coding
 *  and skill tools, and codemode is always present (the only path to the
 *  script-only integration and thread-history tools). */
export function directBaseTools<T extends { name: string }>(
  base: readonly T[],
  agent: { tools: string[]; tools_mode: string } | null,
): readonly T[] {
  if (agent === null || agent.tools_mode === "all") return base;
  const allowed = new Set(agent.tools);
  return base.filter((tool) => tool.name === "codemode" || allowed.has(tool.name));
}
