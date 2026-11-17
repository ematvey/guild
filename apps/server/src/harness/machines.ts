// What the agent knows about machines: the prompt section that lists the
// member's paired machines with the rule that addresses them, and the
// `machine_list` tool that reads the same list again mid-turn. A machine is
// private to the member who paired it, so both read the member's own rows.

import { Type } from "typebox";
import {
  defineTool,
  type ConversationId,
  type ToolExecutionResult,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { renderMachineLines, type MachineTarget } from "../machines/targets.js";

/** The section's opening: what a machine is and how a call addresses one. */
export const MACHINES_SECTION_HEADER = [
  "These are the machines the member paired.",
  "A file tool call (`read`, `write`, `edit`, `bash`, `download`, `send_file`) with a `machine` argument runs on that machine; without it the call runs in the conversation's own environment.",
  "A machine has no shared folder: without `cwd` a call runs in the machine's home directory, and no folder carries from one call to the next, so write a shell command as `cd <folder> && <command>`.",
  "A machine line ends with the OS and the `shell` that runs your `command`: write the command in that shell's language, not in bash. `cmd.exe` has no `$VAR`, no `ls`/`find`/`head`/`which` and no `/dev/null`; use `dir`, `type`, `where`, `%USERPROFILE%` and `2>nul`. A Windows folder under `\\\\wsl.localhost\\<distro>\\…` runs `bash` inside that distro instead.",
].join("\n");

/** The section body: the header, then one line per machine. */
export function renderMachinesSection(machines: readonly MachineTarget[]): string {
  return `${MACHINES_SECTION_HEADER}\n\n${renderMachineLines(machines)}`;
}

const fail = (message: string): ToolExecutionResult => ({
  output: [{ type: "text", text: message }],
  isError: true,
});

export interface MachineListDeps {
  orgOfConversation(conversationId: ConversationId): Promise<string | null>;
  userOfConversation(conversationId: ConversationId): Promise<{ id: string } | null>;
  /** The member's machines with their live flags. */
  list(orgId: string, userId: string): Promise<MachineTarget[]>;
}

/** `machine_list`: the same list the prompt section carries, read again so a
 *  machine paired mid-turn is addressable without a new turn. */
export function createMachineListTool(deps: MachineListDeps): ToolRegistration {
  return defineTool({
    name: "machine_list",
    description:
      "List the machines the member paired, one per line: label, machine id, whether it is online, its OS and the " +
      "shell a `command` runs in there. Pass a machine's id or its unique label as `machine` to run a coding tool " +
      "call on it.",
    parameters: Type.Object({}),
    replay: "safe",
    outputLimits: { maxBytes: 4 * 1024 },
    execute: async (_args, api) => {
      try {
        const orgId = await deps.orgOfConversation(api.conversationId);
        if (orgId === null) return fail("this conversation has no org");
        const user = await deps.userOfConversation(api.conversationId);
        if (user === null) return fail("this conversation has no member");
        return { output: [{ type: "text", text: renderMachineLines(await deps.list(orgId, user.id)) }] };
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  });
}
