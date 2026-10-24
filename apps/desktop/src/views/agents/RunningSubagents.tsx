// The chat's running subagents, rendered at the end of the transcript. It is
// part of the chat body: scrolling up takes it out of view, nothing pins it
// and nothing draws a border. Only running threads appear — the spawn and
// result records in the transcript are the history. The nodes arrive on the
// member socket (the sync bracket plus the guild_subagent_tree push), so the
// tree is always the current server state.

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

/** One vertical guide column: a full line for an ancestor with following
 *  siblings, nothing otherwise. */
function Guide({ draw }: { draw: boolean }) {
  return (
    <span className="relative w-4 shrink-0 self-stretch">
      {draw && <span className="absolute inset-y-0 left-1/2 border-l border-border/60" />}
    </span>
  );
}

function Row({
  entry,
  guides,
  isLast,
  onOpen,
}: {
  entry: RunningSubagentNode;
  guides: readonly boolean[];
  isLast: boolean;
  onOpen: (chatId: string) => void;
}) {
  const { node } = entry;
  const text = label(node);
  return (
    <>
      <div className="flex items-stretch text-xs">
        {guides.map((draw, i) => (
          <Guide key={i} draw={draw} />
        ))}
        <span className="relative w-4 shrink-0 self-stretch">
          <span
            className={`absolute left-1/2 top-0 border-l border-border/60 ${
              isLast ? "h-1/2" : "inset-y-0"
            }`}
          />
          <span className="absolute left-1/2 top-1/2 w-1/2 border-t border-border/60" />
        </span>
        <button
          type="button"
          onClick={() => onOpen(node.chat_id)}
          className="min-w-0 flex-1 truncate rounded py-0.5 text-left text-xs text-foreground/80 hover:text-foreground"
          title={`Open ${text}`}
        >
          {text}
        </button>
      </div>
      {entry.children.map((child, i) => (
        <Row
          key={child.node.thread_id}
          entry={child}
          guides={[...guides, !isLast]}
          isLast={i === entry.children.length - 1}
          onOpen={onOpen}
        />
      ))}
    </>
  );
}

/** Renders nothing when no descendant of this chat is running. The chat's
 *  own title never appears: the tree starts at the running children. */
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
    <div className="mt-8">
      <div className="mb-1.5 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
        Subagents
      </div>
      <div>
        {tree.children.map((child, i) => (
          <Row
            key={child.node.thread_id}
            entry={child}
            guides={[]}
            isLast={i === tree.children.length - 1}
            onOpen={onOpen}
          />
        ))}
      </div>
    </div>
  );
}
