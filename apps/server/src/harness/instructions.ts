// The system instructions of an agent thread: identity, workspace, sharing,
// Generated UI and the workspace config files. Pure over the files it is
// given.

import type { Message } from "@earendil-works/pi-ai";
import { genuiPrompt } from "@guild/genui";
import {
  AGENT_WORKSPACE_PATH,
  CONFIG_FILES,
  TOTAL_MAX_CHARS,
  renderFileBlock,
  type AgentConfigFiles,
} from "../agents/workspace-config.js";

const MEMORY_REVISION_TAG = "guild_memory_revision";
const MEMORY_REVISION_MARKER = new RegExp(
  `\\n<${MEMORY_REVISION_TAG}>([0-9a-f]{64}|)</${MEMORY_REVISION_TAG}>(?=\\n</instructions>$)`,
);

/** Persist the hash with the snapshot so the request hook credits only text the model sees. */
export function attachMemoryRevision(instructions: string, revision: string | undefined): string {
  return instructions + `\n<${MEMORY_REVISION_TAG}>${revision ?? ""}</${MEMORY_REVISION_TAG}>`;
}

export function stripMemoryRevision(message: Message): { message: Message; revision?: string } {
  if (message.role !== "system") return { message };
  const instructions = message.sections?.instructions;
  if (instructions == null) return { message };
  const marker = MEMORY_REVISION_MARKER.exec(instructions);
  if (marker === null) return { message };
  return {
    message: {
      ...message,
      sections: { ...message.sections, instructions: instructions.slice(0, marker.index) + "\n</instructions>" },
    },
    revision: marker[1] || undefined,
  };
}

/** The thread's own context: an isolated routine run, or a delivered thread. */
export interface ThreadInstructionContext {
  type: string;
  routineName: string | null;
  /** A routine run's delivery mode; absent or null reads as "thread". */
  routineDelivery?: "thread" | "new_chat" | null;
  /** The routine whose deliveries this user thread collects. */
  feedRoutineName?: string | null;
  origin: { thread_id: string; title: string } | null;
}

/** The system instructions of an agent thread: who the agent is, where its
 *  files live, what its threads and workspace share, and the workspace
 *  config files themselves (SOUL, AGENTS, USER, MEMORY). The agent edits
 *  those files; the next turn reads
 *  them back. A desktop turn adds the user's project context after them.
 *  Each file is a tagged block carrying its full path, so the two sources
 *  stay distinguishable. Pure over the files it is given. */
/** The machine the user's message came from, as the prompt names it. */
export interface MachineContext {
  /** The label the member gave the machine, else its id. */
  name: string;
  /** "windows 10.0.19045", or null when the machine never reported it. */
  os: string | null;
  /** The shell a `command` runs in ("cmd.exe"), or null when unknown. */
  shell: string | null;
  /** The folder the tools act in; null when the chat has no project. */
  projectFolder: string | null;
}

export function composeAgentInstructions(
  agent: { name: string; description?: string; is_personal: boolean; generative_ui?: boolean },
  config: AgentConfigFiles,
  projectInstructions?: string,
  machine: MachineContext | null = null,
  spawnedBy?: { parent_name: string; depth: number; can_spawn: boolean },
  canDelegate = false,
  thread?: ThreadInstructionContext,
  onMemoryRevision?: (hash: string) => void,
): string {
  const sharing = agent.is_personal
    ? "Only its owner can use this agent, so the workspace is private."
    : "Every thread is private to the user you are talking to. The workspace is shared with everyone who can use this agent.";
  const description = (agent.description?.trim() ?? "").replace(/\.$/, "");
  const parts: string[] = [
    description === ""
      ? `You are ${agent.name}, a persistent agent in Guild.`
      : `You are ${agent.name}, ${description}.`,
    "Your workspace is /workspace. Files there persist across your threads and are your memory; keep durable notes under memories/.",
    "Keep the workspace small. It is your home, not a package store: do not install browsers, desktop apps, models " +
      "or datasets, and delete a temporary tree (node_modules, a virtualenv, a downloaded archive) when the work " +
      "that needed it is done.",
    "Egress reaches package registries only. A download from any other host fails, so do not retry it.",
    sharing,
    "Talk to the user in their own terms. Do not mention workspace paths, sandboxes, tools, models or other internals unless they ask about them.",
  ];
  // Generated UI is for a person reading the thread; a spawned child's reply
  // goes to its parent agent. Static text, placed ahead of the files that
  // change between turns.
  if (agent.generative_ui === true && spawnedBy === undefined) {
    parts.push(`<generated_ui>\n${genuiPrompt()}\n</generated_ui>`);
  }
  const workspace: string[] = [
    "Your own files. Edit them with write/edit; a change applies on your next turn.",
  ];
  let budget = TOTAL_MAX_CHARS;
  for (const entry of CONFIG_FILES) {
    const text = config.files.get(entry.name);
    if (text === undefined) {
      if (entry.required && !config.files.has("AGENTS.override.md")) {
        workspace.push(
          `<agent_workspace_file path="${AGENT_WORKSPACE_PATH}/${entry.name}">\n` +
            `(missing: ${entry.name})\n</agent_workspace_file>`,
        );
      }
      continue;
    }
    if (budget <= 0) break;
    if (entry.name === "MEMORY.md" && config.memoryRevision !== undefined && text.trim().length <= budget) {
      onMemoryRevision?.(config.memoryRevision);
    }
    const block = renderFileBlock(entry.name, text, budget);
    budget -= block.length;
    workspace.push(block);
  }
  parts.push(`<agent_workspace path="${AGENT_WORKSPACE_PATH}">\n${workspace.join("\n\n")}\n</agent_workspace>`);
  if (thread?.type === "routine") {
    const name = (thread.routineName ?? "a routine").replace(/"/g, "&quot;");
    parts.push(
      [
        `<routine_run name="${name}">`,
        "This turn was started by a routine, not by the user. Nobody reads this thread, and its final message is not delivered: the user sees only what you send.",
        "Reach the user with send_message and the full text they should read. When the run found nothing worth reporting, send nothing. Do not restate the result here.",
        thread.routineDelivery === "new_chat"
          ? "Each send_message opens its own conversation with the user."
          : "send_message posts into this routine's one conversation with the user, below the messages earlier runs sent: write each message to stand on its own, and do not repeat what an earlier run already reported.",
        "</routine_run>",
      ].join("\n"),
    );
  }
  const feedRoutine = thread?.feedRoutineName ?? null;
  if (feedRoutine !== null) {
    const name = feedRoutine.replace(/"/g, "&quot;");
    const latest = thread?.origin ?? null;
    parts.push(
      [
        `<routine_thread name="${name}">`,
        `This thread collects the messages the routine "${feedRoutine}" sends the user. Its runs post them here, and they are in your context as your own messages; the user replies here. Older messages may be compacted or missing from your context: thread_history reads the whole thread.`,
        ...(latest === null
          ? []
          : [
              `The latest message came from run thread ${latest.thread_id}; read the work behind it with conversation_read.`,
            ]),
        "</routine_thread>",
      ].join("\n"),
    );
  } else if (thread?.origin !== undefined && thread.origin !== null) {
    const title = thread.origin.title.replace(/"/g, "&quot;");
    const from =
      thread.routineName === null ? "an agent run" : `the routine "${thread.routineName.replace(/"/g, "&quot;")}"`;
    parts.push(
      [
        `<opened_by_agent thread="${thread.origin.thread_id}" title="${title}">`,
        `The agent opened this thread from its own run, while executing ${from}. The user replies here.`,
        `Read the work behind the delivered message with conversation_read on thread ${thread.origin.thread_id}.`,
        "</opened_by_agent>",
      ].join("\n"),
    );
  }
  if (spawnedBy !== undefined) {
    const spawner = spawnedBy.parent_name.replace(/"/g, "&quot;");
    parts.push(
      [
        `<spawned_by agent="${spawner}" depth="${spawnedBy.depth}">`,
        `This thread was spawned by the agent ${spawnedBy.parent_name}.`,
        "Ending your turn is how you reply to the spawner: your final text, plus any files you attach with send_file, " +
          "is delivered to the parent thread. To ask a question, end your turn with the question.",
        spawnedBy.can_spawn ? "You can spawn further child agents." : "You cannot spawn further child agents.",
        "</spawned_by>",
      ].join("\n"),
    );
  }
  if (machine !== null) {
    const where = machine.os === null ? machine.name : `${machine.name} (${machine.os})`;
    const shell = machine.shell === null ? "" : `, and \`command\` runs in \`${machine.shell}\``;
    const folder =
      machine.projectFolder === null
        ? ""
        : ` This thread belongs to the project folder \`${machine.projectFolder}\` on it.`;
    parts.push(
      `The user sent this message from ${where}. Your file tools act in your own workspace; to work on that ` +
        `machine, pass \`machine: "${machine.name}"\`${shell}. \`cwd\` names a folder there; without it a ` +
        `call runs in the machine's home, and no folder carries from one call to the next, so write a ` +
        `command as \`cd <folder> && <command>\`.${folder}`,
    );
  }
  if (canDelegate) {
    parts.push(
      [
        "<delegation>",
        "A spawn returns at once. Do not wait or poll for the child, and do not sleep.",
        "Read a child with read_thread only when you need its progress for a decision; it is not a way to wait.",
        "If the spawned work is all that is left, end your turn; the child's result arrives as a new message and wakes you.",
        "If you have other work, do it now.",
        "</delegation>",
      ].join("\n"),
    );
  }
  const project = projectBlock(projectInstructions);
  if (project !== null) parts.push(project);
  return parts.join("\n\n");
}

/** Server-side cap on the client-sent chain; the desktop truncates to the
 *  same budget before sending, this is the trust boundary. */
export const PROJECT_INSTRUCTIONS_MAX_CHARS = 32 * 1024;

/** The desktop project's instruction chain, appended after the workspace
 *  files in pi's context syntax: the client sends `<project_instructions
 *  path="...">` blocks, this wraps them in the `<project_context>` section.
 *  The text is client-supplied, so it is cut here regardless of what the
 *  client did; empty or whitespace-only input yields no block. */
function projectBlock(text: string | undefined): string | null {
  const trimmed = (text ?? "").trim();
  if (trimmed === "") return null;
  const cut =
    trimmed.length <= PROJECT_INSTRUCTIONS_MAX_CHARS
      ? trimmed
      : `${trimmed.slice(0, PROJECT_INSTRUCTIONS_MAX_CHARS)}\n\n(truncated)`;
  return [
    "<project_context>",
    "Project-specific instructions and guidelines:",
    "From the user's desktop project, not your workspace. These files live on their machine.",
    "",
    cut,
    "</project_context>",
  ].join("\n");
}
