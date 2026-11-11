// The coding tools' three bindings: the plain names with a per-call machine
// target, the same four renamed and bound to the agent sandbox, and the
// allowlist filter the agent applies on top of both.

import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { JsonValue } from "@earendil-works/chord";
import type { ToolExecutionApi, ToolExecutionResult, ToolRegistration } from "@earendil-works/pi-durable";
import { MachineTargetError } from "../machines/targets.js";

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

const textErr = (text: string): ToolExecutionResult => ({ output: [{ type: "text", text }], isError: true });

/** The `machine` argument: which of the member's paired machines the call
 *  runs on. Omitted, the call keeps the conversation's own environment. */
const MACHINE_ARG = {
  type: "string",
  description:
    "A machine to run this call on: its id, or a label unique among the member's machines. Omitted, the call keeps its own environment.",
} as const;

/** The `cwd` argument: the folder the call runs in on that machine. */
const CWD_ARG = {
  type: "string",
  description: "The folder this call runs in on `machine`; needs `machine`.",
} as const;

/** One call on a named machine: who is calling, which chat it belongs to,
 *  and the machine and folder it names. */
export interface MachineCallRequest {
  chatId: string;
  orgId: string;
  userId: string;
  machine: string;
  cwd?: string;
}

export interface RoutedCodingOptions {
  chatId: string;
  orgId: string;
  userId: string;
  /** The environment for one call on a named machine; it throws
   *  `MachineTargetError` when the member cannot make that call. */
  envFor(request: MachineCallRequest): Promise<ExecutionEnv>;
}

/** Adds the machine target to one coding tool: `machine` swaps the call's
 *  environment for that machine's, `cwd` sets the folder it runs in. */
function routeCodingTool(tool: ToolRegistration, options: RoutedCodingOptions): ToolRegistration {
  const parameters = tool.parameters as { properties?: Record<string, unknown> };
  const run = tool.execute.bind(tool) as (
    args: Record<string, unknown>,
    api: ToolExecutionApi,
    context: Parameters<NonNullable<ToolRegistration["execute"]>>[2],
  ) => Promise<ToolExecutionResult>;
  return {
    ...tool,
    parameters: {
      ...parameters,
      properties: { ...(parameters.properties ?? {}), machine: MACHINE_ARG, cwd: CWD_ARG },
    },
    execute: async (args, api, context) => {
      const { machine, cwd, ...rest } = args as Record<string, unknown> & { machine?: unknown; cwd?: unknown };
      if (machine === undefined) {
        if (cwd !== undefined) return textErr("cwd needs machine: it names a folder on that machine");
        return run(rest, api, context);
      }
      if (typeof machine !== "string" || machine.trim() === "") {
        return textErr("machine must name one of the member's machines: its id, or a unique label");
      }
      if (cwd !== undefined && (typeof cwd !== "string" || cwd === "")) {
        return textErr("cwd must be a folder path on that machine");
      }
      let env: ExecutionEnv;
      try {
        env = await options.envFor({
          chatId: options.chatId,
          orgId: options.orgId,
          userId: options.userId,
          machine,
          ...(typeof cwd === "string" ? { cwd } : {}),
        });
      } catch (error) {
        if (error instanceof MachineTargetError) return textErr(error.message);
        throw error;
      }
      return run(rest, withEnv(api, env), context);
    },
  } as ToolRegistration;
}

/** The four coding tools with a per-call machine target. Without `machine`
 *  they act on the conversation's own environment: the sandbox, or the
 *  project's machine and folder on a project-bound chat. */
export function createRoutedCodingTools(options: RoutedCodingOptions): ToolRegistration[] {
  return [createReadTool(), createWriteTool(), createEditTool(), createBashTool()].map((tool) =>
    routeCodingTool(tool, options),
  );
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
    description:
      `${tool.description} Runs in your own agent workspace (the sandbox), not on the user's machine. ` +
      "Pass timeout (seconds) for any command that can block. Keep the workspace small: do not install " +
      "browsers, desktop apps, models or datasets there, and remove a temporary tree when it is no longer needed.",
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
