// Subagent lifecycle records in the parent transcript: the spawn, the result
// and the close. Each is a record in the thread like a tool call — a
// collapsible Frame — and each one opens the child thread it names.

import { Bot, CircleSlash, CornerUpRight, SquareArrowOutUpRight } from "lucide-react";
import { Frame, FRAME_ROW_CLASS } from "../frame";
import { PayloadPre } from "../payload-pre";
import type { ChildClosedBlock, ChildResultBlock, ChildSpawnBlock } from "../../lib/thread-reducer";

function OpenThreadButton({
  chatId,
  agentName,
  onOpen,
}: {
  chatId?: string | null;
  agentName: string;
  onOpen: (chatId: string) => void;
}) {
  return (
    <button
      type="button"
      disabled={!chatId}
      onClick={() => {
        if (chatId) onOpen(chatId);
      }}
      className="inline-flex items-center gap-1 rounded border border-border/60 px-1.5 py-0.5 text-2xs text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground disabled:opacity-40"
      title={chatId ? `Open ${agentName} thread` : "This record carries no thread"}
    >
      <SquareArrowOutUpRight className="size-3" />
      Open thread
    </button>
  );
}

/** The spawn record: which agent, which session name, and the request the
 *  parent sent. */
export function SubagentSpawnRecord({ block, onOpen }: { block: ChildSpawnBlock; onOpen: (chatId: string) => void }) {
  const task = (block.task ?? "").trim();
  return (
    <Frame
      icon={<Bot className="size-3 shrink-0 text-muted-foreground" />}
      title={
        <>
          <span className="mr-3 font-medium text-foreground/80">Created a subagent</span>
          <span>
            {block.agentName}
            {block.title ? ` · ${block.title}` : ""}
          </span>
        </>
      }
    >
      <div className="space-y-2">
        {task === "" ? <p className="text-xs">No request recorded.</p> : <PayloadPre text={task} />}
        <OpenThreadButton chatId={block.chatId} agentName={block.agentName} onOpen={onOpen} />
      </div>
    </Frame>
  );
}

/** The result record: the child's terminal status and what it returned. */
export function SubagentResultRecord({ block, onOpen }: { block: ChildResultBlock; onOpen: (chatId: string) => void }) {
  const returned = (block.finalText ?? "").trim();
  const failed = block.status !== "succeeded";
  return (
    <Frame
      icon={<CornerUpRight className="size-3 shrink-0 text-muted-foreground" />}
      title={
        <>
          <span className="mr-3 font-medium text-foreground/80">Subagent finished</span>
          <span>
            {block.agentName}
            {block.title ? ` · ${block.title}` : ""}
            {failed ? ` · ${block.status}` : ""}
          </span>
        </>
      }
    >
      <div className="space-y-2">
        {returned === "" ? <p className="text-xs">No answer returned.</p> : <PayloadPre text={returned} />}
        <OpenThreadButton chatId={block.chatId} agentName={block.agentName} onOpen={onOpen} />
      </div>
    </Frame>
  );
}

/** The close record: the thread is gone from the running tree, and the
 *  transcript keeps the fact. */
export function SubagentClosedRecord({ block, onOpen }: { block: ChildClosedBlock; onOpen: (chatId: string) => void }) {
  return (
    <div className={`${FRAME_ROW_CLASS} text-sm text-muted-foreground`}>
      <CircleSlash className="size-3 shrink-0" />
      <span className="min-w-0 flex-1 truncate">
        Closed subagent {block.agentName}
        {block.title ? ` · ${block.title}` : ""}
      </span>
      <OpenThreadButton chatId={block.chatId} agentName={block.agentName} onOpen={onOpen} />
    </div>
  );
}
