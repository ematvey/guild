// The system instructions of an agent thread: identity, workspace, sharing
// and the workspace config files. Pure over the files it is given.

import {
  AGENT_WORKSPACE_PATH,
  CONFIG_FILES,
  TOTAL_MAX_CHARS,
  renderFileBlock,
  type AgentConfigFiles,
} from "../agents/workspace-config.js";

/** What the current thread is, beyond its agent: a routine run is isolated
 *  from the user, and a thread the agent opened links back to its run. */
export interface ThreadInstructionContext {
  kind: string;
  routineName: string | null;
  origin: { thread_id: string; title: string } | null;
}

/** The system instructions of an agent thread: who the agent is, where its
 *  files live, what its threads and workspace share, and the workspace
 *  config files themselves (SOUL, AGENTS, USER, MEMORY). The agent edits
 *  those files; the next turn reads
 *  them back. A desktop turn adds the user's project context after them.
 *  Each file is a tagged block carrying its full path, so the two sources
 *  stay distinguishable. Pure over the files it is given. */
export function composeAgentInstructions(
  agent: { name: string; description?: string; is_personal: boolean },
  config: AgentConfigFiles,
  projectInstructions?: string,
  machineBound = false,
  spawnedBy?: { parent_name: string; depth: number; can_spawn: boolean },
  canDelegate = false,
  thread?: ThreadInstructionContext,
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
    sharing,
    "Talk to the user in their own terms. Do not mention workspace paths, sandboxes, tools, models or other internals unless they ask about them.",
  ];
  const workspace: string[] = [
    machineBound
      ? "Your own files. Read them with agent_read and edit them with agent_write/agent_edit; " +
        "a change applies on your next turn."
      : "Your own files. Edit them with write/edit; a change applies on your next turn.",
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
    const block = renderFileBlock(entry.name, text, budget);
    budget -= block.length;
    workspace.push(block);
  }
  parts.push(
    `<agent_workspace path="${AGENT_WORKSPACE_PATH}">\n${workspace.join("\n\n")}\n</agent_workspace>`,
  );
  if (thread?.kind === "routine_run") {
    const name = (thread.routineName ?? "a routine").replace(/"/g, "&quot;");
    parts.push(
      [
        `<routine_run name="${name}">`,
        "This turn was started by a routine, not by the user. Nobody reads this thread: the user sees only what you send.",
        "Deliver the result by calling send_message with the full text the user should read. Your final message here stays in this thread.",
        "</routine_run>",
      ].join("\n"),
    );
  }
  if (thread?.origin !== undefined && thread.origin !== null) {
    const title = thread.origin.title.replace(/"/g, "&quot;");
    const from = thread.routineName === null ? "an agent run" : `the routine "${thread.routineName.replace(/"/g, "&quot;")}"`;
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
        spawnedBy.can_spawn
          ? "You can spawn further child agents."
          : "You cannot spawn further child agents.",
        "</spawned_by>",
      ].join("\n"),
    );
  }
  if (machineBound) {
    parts.push(
      "This chat is bound to the user's project, so `read`, `write`, `edit` and `bash` act on their machine " +
        "in the project folder. `agent_read`, `agent_write`, `agent_edit` and `agent_bash` act in your own " +
        "workspace sandbox; that sandbox is a full Linux environment, so other paths there work too.",
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
