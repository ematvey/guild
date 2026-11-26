// The transcript pane: the scrolling message column of the open chat, its
// empty and loading states, the older-page button, the running subagents and
// the jump-to-bottom button.
import { memo, useMemo, type RefObject, type UIEvent } from "react";
import Markdown from "react-markdown";
import { ArrowDown, CornerUpLeft, Loader2 } from "lucide-react";
import { Button } from "@guild/ui/components/button";
import { CHAT_MD_PLUGINS, MD_CLASS, MD_TABLE_CLASS, mdComponents, WRAP_ANYWHERE } from "../markdown";
import { FrameToggleContext } from "../frame";
import { WorkedForBlock, viewEntries } from "../worked-for-block";
import { RunningSubagents } from "../agents/RunningSubagents";
import { SubagentClosedRecord, SubagentResultRecord, SubagentSpawnRecord } from "../agents/subagent-blocks";
import type { ChatSubagentNode } from "../../lib/api/chats";
import type { RenderBlock } from "../../lib/thread-reducer";
import {
  ThreadSkeleton,
  ThreadProgress,
  ReasoningFrame,
  CompactionCard,
  MessageStamp,
  CHAT_COLUMN_CLASS,
} from "./blocks";
import { ToolFrame } from "./tool-blocks";
import { ApprovalCard } from "./approval-card";
import { GenuiPlacementContext, answersAfter } from "../genui/actions";
import { AttachmentImageThumb, AttachmentFileChip } from "./attachments";

/** A settled agent text block. Markdown parsing dominates a long transcript,
 *  and the reducer keeps earlier block objects identical across live deltas
 *  and state publishes, so this memo hits for every settled block. */
const TextBlock = memo(function TextBlock({
  b,
  live,
  answer,
  showInterrupted,
  origin,
  onOpenOrigin,
}: {
  b: RenderBlock;
  /** The turn is still writing this block: its Generated UI stays inert. */
  live: boolean;
  /** The first user message after this block: its Generated UI is
   *  answered and settles. */
  answer: string | null;
  showInterrupted: boolean;
  /** The run this message was delivered from. Rendered in the body so the
   *  timestamp stays under the link. */
  origin?: { chat_id: string; title: string } | null;
  onOpenOrigin?: (chatId: string) => void;
}) {
  const placement = useMemo(() => ({ streaming: live, answer }), [live, answer]);
  return (
    <div
      data-agent-message
      className="group [&+[data-agent-message]]:border-t [&+[data-agent-message]]:border-border/70 [&+[data-agent-message]]:pt-5"
    >
      <div className={`max-w-none space-y-3 leading-[1.75] ${MD_CLASS} ${MD_TABLE_CLASS}`}>
        <GenuiPlacementContext.Provider value={placement}>
          <Markdown remarkPlugins={CHAT_MD_PLUGINS} components={mdComponents}>
            {b.text}
          </Markdown>
        </GenuiPlacementContext.Provider>
        {b.attachments && b.attachments.length > 0 && (
          <div className="flex max-w-full flex-wrap items-start gap-2">
            {b.attachments
              .filter((a) => a.modality === "image")
              .map((a) => (
                <AttachmentImageThumb key={a.id} att={a} />
              ))}
            {b.attachments
              .filter((a) => a.modality !== "image")
              .map((a) => (
                <AttachmentFileChip key={a.id} att={a} />
              ))}
          </div>
        )}
        {origin != null && (
          <button
            type="button"
            onClick={() => onOpenOrigin?.(origin.chat_id)}
            className="flex w-fit items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <CornerUpLeft className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="truncate">Opened by the agent run</span>
            <span className="max-w-56 truncate text-foreground">{origin.title}</span>
          </button>
        )}
        {b.interrupted && showInterrupted && <div className="text-xs text-muted-foreground">stopped</div>}
      </div>
      <MessageStamp ts={b.ts} copyText={b.text} />
    </div>
  );
});

/** View entries: each contiguous thinking/tool run becomes one
 *  WorkedForBlock; everything else (user, the turn's final text, errors,
 *  compaction cards, queued-send chips, approvals) stays 1:1. A settled
 *  turn's earlier messages fold into its run. Every agent text block carries
 *  the hover stamp with its time and copy button. */
function useDisplayEntries(blocks: RenderBlock[], busy: boolean) {
  return useMemo(() => viewEntries(blocks, busy), [blocks, busy]);
}

export interface ThreadPaneScroll {
  pane: RefObject<HTMLDivElement | null>;
  onScroll: (e: UIEvent<HTMLDivElement>) => void;
  setContentEl: (el: HTMLDivElement | null) => void;
  composerH: number;
  onFrameToggle: () => void;
  atBottom: boolean;
  scrollToBottom: () => void;
}

export function ThreadPane({
  blocks,
  loading,
  viewChatId,
  noModels,
  navigating,
  hasMore,
  loadingEarlier,
  onLoadEarlier,
  compacting,
  busy,
  stopping,
  subagentNodes,
  originLink,
  onOpenChat,
  onOpenChildChat,
  scroll,
}: {
  blocks: RenderBlock[];
  loading: boolean;
  viewChatId: string | null;
  /** No model is configured: the scratch view says so. */
  noModels: boolean;
  navigating: boolean;
  hasMore: boolean;
  loadingEarlier: boolean;
  onLoadEarlier: () => void;
  compacting: boolean;
  busy: boolean;
  stopping: Record<string, true>;
  subagentNodes: ChatSubagentNode[];
  /** The run thread a delivered message came from. */
  originLink: { chat_id: string; title: string } | null;
  onOpenChat: (chatId: string) => void;
  onOpenChildChat: (chatId: string) => void;
  scroll: ThreadPaneScroll;
}) {
  const displayEntries = useDisplayEntries(blocks, busy);
  const isStopping = !!(viewChatId && stopping[viewChatId]);

  // The transcript is the expensive subtree: every keystroke in the
  // composer re-renders the view, and a long thread holds thousands of
  // markdown blocks. Memoizing the element list keeps those elements
  // identical across prompt edits, so React bails out of the transcript.
  const lastBlockIndex = blocks.length - 1;
  const answers = useMemo(() => {
    const after = answersAfter(blocks);
    return new Map(blocks.map((b, i) => [b.key, after[i] ?? null]));
  }, [blocks]);
  const firstTextIndex = displayEntries.findIndex((e) => e.kind === "plain" && e.b.kind === "text");
  const transcriptEntries = useMemo(
    () =>
      displayEntries.map((e, i) =>
        e.kind === "work" ? (
          <WorkedForBlock
            key={`work-${e.run[0]!.key}`}
            run={e.run}
            active={busy && i === displayEntries.length - 1}
            stopping={isStopping}
            turnStart={e.turnStart}
          >
            {e.run.map((b) =>
              b.kind === "reasoning" ? (
                <ReasoningFrame
                  key={b.key}
                  text={b.reasoningText ?? ""}
                  live={busy && b.key === blocks[lastBlockIndex]?.key}
                />
              ) : b.kind === "text" ? (
                // An intermediate message of a settled turn: it sits in the
                // run, behind the worked-for row, in arrival order.
                <TextBlock
                  key={b.key}
                  b={b}
                  live={false}
                  answer={answers.get(b.key) ?? null}
                  showInterrupted={!busy}
                  origin={null}
                  onOpenOrigin={onOpenChat}
                />
              ) : b.kind === "tool" && b.tool ? (
                <ToolFrame key={b.key} t={b.tool} />
              ) : b.kind === "child_spawn" && b.childSpawn ? (
                <SubagentSpawnRecord key={b.key} block={b.childSpawn} onOpen={onOpenChildChat} />
              ) : b.kind === "child_result" && b.childResult ? (
                <SubagentResultRecord key={b.key} block={b.childResult} onOpen={onOpenChildChat} />
              ) : b.kind === "child_closed" && b.childClosed ? (
                <SubagentClosedRecord key={b.key} block={b.childClosed} onOpen={onOpenChildChat} />
              ) : null,
            )}
          </WorkedForBlock>
        ) : e.b.kind === "user" ? (
          <div key={e.b.key} className="group ml-auto w-fit max-w-[80%]">
            <div className={`rounded-2xl bg-secondary px-4 py-2.5 text-base leading-[1.75] ${WRAP_ANYWHERE}`}>
              {e.b.text && <div className="whitespace-pre-wrap">{e.b.text}</div>}
              {e.b.attachments && e.b.attachments.length > 0 && (
                <div className="mt-1 flex max-w-full flex-wrap items-start justify-end gap-2">
                  {e.b.attachments
                    .filter((a) => a.modality === "image")
                    .map((a) => (
                      <AttachmentImageThumb key={a.id} att={a} />
                    ))}
                  {e.b.attachments
                    .filter((a) => a.modality !== "image")
                    .map((a) => (
                      <AttachmentFileChip key={a.id} att={a} />
                    ))}
                </div>
              )}
            </div>
            <MessageStamp ts={e.b.ts} copyText={e.b.text} />
          </div>
        ) : e.b.kind === "approval" && e.b.approval ? (
          <ApprovalCard key={e.b.key} a={e.b.approval} chatId={viewChatId} />
        ) : e.b.kind === "compaction" && e.b.compaction ? (
          <CompactionCard key={e.b.key} c={e.b.compaction} />
        ) : e.b.kind === "error" ? (
          <div
            key={e.b.key}
            className="w-fit rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive"
          >
            {e.b.text}
          </div>
        ) : (
          <TextBlock
            key={e.b.key}
            b={e.b}
            live={busy && i === displayEntries.length - 1}
            answer={answers.get(e.b.key) ?? null}
            showInterrupted={!busy}
            origin={i === firstTextIndex ? originLink : null}
            onOpenOrigin={onOpenChat}
          />
        ),
      ),
    [
      displayEntries,
      busy,
      viewChatId,
      isStopping,
      lastBlockIndex,
      blocks,
      onOpenChildChat,
      onOpenChat,
      originLink,
      firstTextIndex,
      answers,
    ],
  );

  if (blocks.length === 0) {
    if (loading) return <ThreadSkeleton />;
    if (!viewChatId) {
      return (
        <div className="flex flex-1 flex-col items-center justify-center overflow-y-auto px-4 pb-32 py-8">
          {noModels && (
            <p className="rounded-md border border-amber-700/60 bg-amber-900/30 px-3 py-1.5 text-amber-300">
              no models configured — ask an admin to add a route
            </p>
          )}
        </div>
      );
    }
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-4 pb-32 py-8">
        <p className="text-muted-foreground">No messages in this thread yet.</p>
      </div>
    );
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {navigating && <ThreadProgress />}
      <FrameToggleContext.Provider value={scroll.onFrameToggle}>
        <div
          ref={scroll.pane}
          data-scrollable
          className="min-h-0 flex-1 overflow-x-clip overflow-y-auto overscroll-contain [overflow-anchor:none] [scrollbar-gutter:stable]"
          onScroll={scroll.onScroll}
        >
          <div
            ref={scroll.setContentEl}
            className={`${CHAT_COLUMN_CLASS} space-y-6 px-4 pt-6 text-base text-[var(--chat-foreground)] [&_strong]:text-foreground [&_b]:text-foreground`}
            style={{ paddingBottom: scroll.composerH + 48 }}
          >
            {hasMore && (
              <div className="flex justify-center">
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground"
                  disabled={loadingEarlier}
                  onClick={onLoadEarlier}
                >
                  {loadingEarlier ? "Loading earlier messages…" : "Load earlier messages"}
                </Button>
              </div>
            )}
            {transcriptEntries}
            {/* The running part of the chat's thread subtree; the nodes
                arrive on the member socket. */}
            <RunningSubagents nodes={subagentNodes} onOpen={onOpenChildChat} />
            {/* in-progress /compact line: replaced by the durable
                "Context compacted" card when the event lands. The reducer
                computes the guard (its armed target vs the open chat) —
                with chatId still null during a first send it never holds. */}
            {compacting && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />
                <span>Compacting thread…</span>
              </div>
            )}
          </div>
        </div>
      </FrameToggleContext.Provider>
      {/* Floating jump-to-bottom: only while the user reads above the tail,
          above the composer so it never covers it. */}
      {!scroll.atBottom && (
        <div
          className="pointer-events-none absolute inset-x-0 z-20 px-3 sm:px-4"
          style={{ bottom: scroll.composerH - 12 }}
        >
          <div className={`${CHAT_COLUMN_CLASS} flex justify-end`}>
            <button
              type="button"
              onClick={scroll.scrollToBottom}
              aria-label="Scroll to the bottom"
              title="Scroll to the bottom"
              className="pointer-events-auto flex size-9 items-center justify-center rounded-full border border-border bg-card text-muted-foreground shadow-lg transition-colors hover:bg-muted hover:text-foreground pointer-coarse:size-10"
            >
              <ArrowDown className="size-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
