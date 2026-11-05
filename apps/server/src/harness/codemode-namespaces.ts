// Codemode tool namespaces: the groups the `codemode` prompt section lists
// tools under (`## <namespace>`), and what a script's `describeNamespace()`
// and `searchTools(q, { namespace })` answer. Scripts still call every tool
// flat as `tools.<name>`; a namespace groups tools for discovery only.
//
// pi-durable assigns a tool to the namespace whose prefix is the longest
// one its name starts with. Guild's groups are exact tool lists (built-in
// groups, an integration's tools, a user MCP server's tools), so each
// member becomes its own namespace entry whose prefix is the member's full
// name. Groups differ per conversation (org integrations, the owner's MCP
// servers), so the extension resolves them for each section render and
// each codemode call instead of once at install.

import {
  createCodemodeExtension,
  createCodemodeTool,
  CODEMODE_TOOL_NAME,
  type CodemodeNamespace,
  type CodemodeToolOptions,
} from "@earendil-works/pi-durable/codemode";
import type { Extension, PromptSection, ToolRegistration } from "@earendil-works/pi-durable";

/** A named set of tools that one namespace lists. */
export interface ToolGroup {
  name: string;
  description?: string;
  /** Usage notes returned by `describeNamespace()`. */
  instructions?: string;
  tools: readonly string[];
}

/** Guild's own script-callable tools, grouped. Tools absent from a
 *  conversation's callable set are skipped; ungrouped tools are listed
 *  first, without a heading. */
export const BUILTIN_TOOL_GROUPS: readonly ToolGroup[] = [
  {
    name: "subagents",
    description: "Child agent threads you start, message, read, stop and close.",
    tools: ["list_agents", "spawn", "send", "list", "read_thread", "cancel", "close"],
  },
  {
    name: "conversations",
    description: "This agent's own threads, and send_message, which opens a thread with the user.",
    tools: ["conversations_search", "conversations_list", "conversation_read", "send_message"],
  },
  {
    name: "routines",
    description: "This agent's schedules: recurring routines and one-shot reminders.",
    tools: ["list_routines", "create_routine", "update_routine", "delete_routine", "schedule_reminder"],
  },
  {
    name: "skills",
    description: "The org skill catalog.",
    tools: ["search_skills", "read_skill", "push_skill"],
  },
  {
    name: "chat_history",
    description: "Messages of this chat and the owner's other chats.",
    tools: ["thread_history", "thread_search"],
  },
  {
    name: "guild",
    description:
      "The whole org, for an admin's personal assistant: members, model usage, every member's threads and " +
      "every agent.",
    tools: [
      "guild_overview",
      "guild_members",
      "guild_usage",
      "guild_threads",
      "guild_thread_read",
      "guild_agents",
    ],
  },
  {
    name: "files",
    description: "Files: message attachments and files you send to the user.",
    tools: ["download_attachment", "send_file"],
  },
];

/** The namespace entries for `groups`, restricted to `callable`. A tool in
 *  several groups stays in the first; a group whose name is taken gets a
 *  numeric suffix. An entry whose prefix would also capture a tool outside
 *  its group (`send` and `send_message`) is dropped, leaving its tool
 *  ungrouped rather than misfiled. */
export function codemodeNamespaces(groups: readonly ToolGroup[], callable: readonly string[]): CodemodeNamespace[] {
  const available = new Set(callable);
  const assigned = new Map<string, string>();
  const names = new Set<string>();
  let entries: CodemodeNamespace[] = [];
  for (const group of groups) {
    const members = group.tools.filter((tool) => available.has(tool) && !assigned.has(tool));
    if (members.length === 0) continue;
    let name = group.name;
    for (let n = 2; names.has(name); n++) name = `${group.name}_${n}`;
    names.add(name);
    for (const tool of members) {
      assigned.set(tool, name);
      entries.push({
        name,
        prefix: tool,
        ...(group.description === undefined ? {} : { description: group.description }),
        ...(group.instructions === undefined ? {} : { instructions: group.instructions }),
      });
    }
  }
  for (;;) {
    const before = entries.length;
    for (const tool of callable) {
      const owner = namespaceOf(tool, entries);
      if (owner !== undefined && owner.name !== assigned.get(tool)) {
        entries = entries.filter((entry) => entry !== owner);
      }
    }
    if (entries.length === before) return entries;
  }
}

/** pi-durable's rule: the entry with the longest prefix the name starts with. */
function namespaceOf(name: string, entries: readonly CodemodeNamespace[]): CodemodeNamespace | undefined {
  let found: CodemodeNamespace | undefined;
  for (const entry of entries) {
    if (name.startsWith(entry.prefix) && (found === undefined || entry.prefix.length > found.prefix.length)) {
      found = entry;
    }
  }
  return found;
}

/** The codemode extension with namespaces resolved per conversation:
 *  `groupsFor` gives the conversation's groups (the built-ins included). A
 *  codemode call records its namespaces in its start data, so a call
 *  resumed after a restart keeps the ones it started with. */
export function createNamespacedCodemodeExtension(
  options: Omit<CodemodeToolOptions, "namespaces">,
  groupsFor: (conversationId: number) => Promise<readonly ToolGroup[]>,
): Extension {
  const base = createCodemodeExtension(options);
  const resolved = async (conversationId: number, callable: readonly ToolRegistration[]) => ({
    ...options,
    namespaces: codemodeNamespaces(
      await groupsFor(conversationId),
      callable.map((tool) => tool.name),
    ),
  });
  const tools = (base.tools ?? []).map((tool): ToolRegistration => {
    if (tool.name !== CODEMODE_TOOL_NAME) return tool;
    return {
      ...tool,
      async execute(args, api, context) {
        const agent = await api.agent(context);
        const namespaced = createCodemodeTool(await resolved(Number(api.conversationId), agent.callable));
        return namespaced.execute(args as never, api, context);
      },
    };
  });
  const sections = (base.sections ?? []).map((section): PromptSection => {
    if (section.key !== "codemode") return section;
    return {
      ...section,
      async render(input, context) {
        const namespaced = createCodemodeExtension(
          await resolved(Number(input.conversationId), input.agent.callable),
        ).sections?.find((candidate) => candidate.key === "codemode");
        return namespaced?.render(input, context);
      },
    };
  });
  return { ...base, tools, sections };
}
