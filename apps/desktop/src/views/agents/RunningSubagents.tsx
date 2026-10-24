// The chat's running subagents, rendered at the end of the transcript. It is
// part of the chat body: scrolling up takes it out of view, nothing pins it
// and nothing draws a border. Only running threads appear — the spawn and
// result records in the transcript are the history.

import type { ChatSubagentNode } from "../../transport";

export interface RunningSubagentNode {
  node: ChatSubagentNode;
  children: RunningSubagentNode[];
}

export function isRunningStatus(status: string | null | undefined): boolean {
  return status === "running" || status === "queued";
}

/** Builds the tree under the chat's own thread and keeps only the part that
 *  is still running: a node stays when it runs or when a descendant runs.
 *  Null when nothing runs. */
export function runningSubagentTree(nodes: readonly ChatSubagentNode[]): RunningSubagentNode | null {
  const byThread = new Map<string, ChatSubagentNode>();
  for (const node of nodes) byThread.set(node.thread_id, node);
  const root = nodes.find((node) => node.parent_thread_id === null);
  if (root === undefined) return null;

  const childrenOf = new Map<string, ChatSubagentNode[]>();
  for (const node of nodes) {
    if (node.parent_thread_id === null) continue;
    if (!byThread.has(node.parent_thread_id)) continue;
    const list = childrenOf.get(node.parent_thread_id);
    if (list === undefined) childrenOf.set(node.parent_thread_id, [node]);
    else list.push(node);
  }

  const keep = (node: ChatSubagentNode): RunningSubagentNode | null => {
    const kept = (childrenOf.get(node.thread_id) ?? [])
      .map(keep)
      .filter((child): child is RunningSubagentNode => child !== null);
    if (!isRunningStatus(node.status) && kept.length === 0) return null;
    return { node, children: kept };
  };

  const keptRoot = keep(root);
  if (keptRoot === null || keptRoot.children.length === 0) return null;
  return keptRoot;
}

function label(node: ChatSubagentNode): string {
  return node.title.trim() === "" ? node.agent_name : `${node.agent_name} · ${node.title}`;
}

function Row({
  entry,
  depth,
  onOpen,
}: {
  entry: RunningSubagentNode;
  depth: number;
  onOpen: (chatId: string) => void;
}) {
  const { node } = entry;
  const root = depth === 0;
  const text = root ? (node.title.trim() === "" ? "This chat" : node.title) : label(node);
  return (
    <div>
      <button
        type="button"
        disabled={root}
        onClick={() => {
          if (!root) onOpen(node.chat_id);
        }}
        className={
          root
            ? "block max-w-full truncate text-left text-xs text-muted-foreground"
            : "block max-w-full truncate rounded text-left text-xs text-foreground/80 hover:text-foreground"
        }
        style={{ paddingLeft: depth * 14 }}
        title={root ? text : `Open ${label(node)}`}
      >
        {text}
      </button>
      {entry.children.map((child) => (
        <Row key={child.node.thread_id} entry={child} depth={depth + 1} onOpen={onOpen} />
      ))}
    </div>
  );
}

/** Renders nothing when no descendant of this chat is running. */
export function RunningSubagents({
  nodes,
  onOpen,
}: {
  nodes: readonly ChatSubagentNode[];
  onOpen: (chatId: string) => void;
}) {
  const tree = runningSubagentTree(nodes);
  if (tree === null) return null;
  return (
    <div className="space-y-0.5">
      <div className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
        Subagents
      </div>
      <Row entry={tree} depth={0} onOpen={onOpen} />
    </div>
  );
}
