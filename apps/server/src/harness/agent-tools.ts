// The file tools' machine target: one `machine` argument, one environment
// swap, shared by every tool that reads or writes a file.

import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { JsonValue } from "@earendil-works/chord";
import type { ToolExecutionApi, ToolExecutionResult, ToolRegistration } from "@earendil-works/pi-durable";
import { MachineTargetError } from "../machines/targets.js";

/** The tool API with `env` replaced: pi's tools resolve their environment
 *  through `api.env`, so this is the whole binding. */
const MACHINE_TARGET = Symbol("machine-tool-call");

/** Trusted routing context after the machine argument has been consumed. */
export function isMachineToolCall(api: ToolExecutionApi): boolean {
  return Reflect.get(api, MACHINE_TARGET) === true;
}

function withEnv<T extends JsonValue>(api: ToolExecutionApi<T>, env: ExecutionEnv): ToolExecutionApi<T> {
  return new Proxy(api, {
    get(target, prop, receiver) {
      if (prop === "env") return env;
      if (prop === MACHINE_TARGET) return true;
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

/** What a tool needs to send one call to a machine: the caller resolves it
 *  per call, because a conversation-scoped tool has no static caller. */
export interface MachineTargetOptions {
  /** The environment for one call on a named machine; it throws
   *  `MachineTargetError` when the member cannot make that call. */
  envFor(api: ToolExecutionApi, request: { machine: string; cwd?: string }): Promise<ExecutionEnv>;
}

/** Adds the machine target to one file tool: `machine` swaps the call's
 *  environment for that machine's, `cwd` sets the folder it runs in. Every
 *  file tool takes the same two arguments with the same meaning. */
export function withMachineTarget(tool: ToolRegistration, options: MachineTargetOptions): ToolRegistration {
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
        env = await options.envFor(api, {
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
 *  they act on the conversation's own environment: the agent's workspace. */
export function createRoutedCodingTools(options: RoutedCodingOptions): ToolRegistration[] {
  return [createReadTool(), createWriteTool(), createEditTool(), createBashTool()].map((tool) =>
    withMachineTarget(tool, {
      envFor: (_api, request) =>
        options.envFor({
          chatId: options.chatId,
          orgId: options.orgId,
          userId: options.userId,
          machine: request.machine,
          ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
        }),
    }),
  );
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
