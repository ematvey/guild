# Thread UI jitter and subagent status — analysis

Date: 2026-10-25
Scope: desktop thread view, member socket, chat status, subagent tree.
Evidence: two screen recordings (new chat, subagent navigation), the dev
database, and the code paths below.

## Bottom line

Four separate defects cause the symptoms:

1. The new-chat sidebar row has no title for a moment. An empty title
   collapses the row by 6 px. Every row below jumps when the title lands.
2. `generating` only means "this chat has its own turn". A parent with
   running children is idle by that flag, so the sidebar and the open thread
   show no busy state.
3. The subagent tree does travel over the WebSocket. But the client clears it
   on every navigation, and the server sends it last in the sync bracket.
   So it pops in after the thread content.
4. Navigation paints a skeleton first, then swaps the header and the composer
   when the child-tree HTTP call returns. The scroll pin also ignores late
   content. That is the visible jump sequence.

## Evidence

### New chat recording

Frame analysis at 6 fps:

- The main column does not move. The sidebar moves down by 6 px at t=0.33 s.
- At that moment the new row changes from "spinner only" to "title + spinner".
- The chat header also changes from empty to the generated title.

Cause: the chat row is created with a null title. The server names the
thread during the first turn. The sidebar renders the row immediately.

`ChatListItem` (`apps/desktop/src/views/sidebar/rows.tsx:159`) has a
`py-1.5` button. The title is an empty `FadeTitle` span, so it has no line
box. The row height is the 14 px spinner plus padding. When the title
arrives, the 20 px line box appears and the row grows by 6 px. The spinner
also moves from the left edge to the right edge.

### Subagent navigation recording

Frame analysis at 6 fps:

- Parent thread → child thread shows a full `ThreadSkeleton` for about
  0.5 s (t≈5.7–6.2 s).
- During the skeleton the composer is still the normal editable composer.
- When the thread content lands, the composer becomes the read-only
  "Subagent thread" banner.
- Later the header changes again: child title → child + parent title.
- Content also shifts when the header/composer swap changes the measured
  composer height.

Cause: three independent async sources paint at three different times:

1. `ThreadState` from the member socket.
2. `fetchChatTree` over HTTP (`use-thread-store.ts:128`).
3. The subagent tree from the sync bracket.

`readOnlyThread` (`Thread.tsx:640`) stays false while `threadLoading` is
true or while the chat lists are null (`status.ts:38-41`). So the composer
is editable during the skeleton. It flips only when the thread load ends.
The child tree arrives later and changes the header.

### Status of the reported thread

Dev database, chat `01a17014-4731-7913-810c-e873ca0a51d3`:

```
title: Acme Infrastructure Status Check
generating: f

parent thread  depth 0  last run: succeeded
child thread   depth 1  last run: running
```

So the parent chat is honestly "not generating". The child is still
running. The UI has no state that expresses "a descendant is working".

## Issue 1 — new chat jitters

### Root causes

- Empty title row collapses the sidebar row (see above).
- The header title is empty until the chat row or the title push arrives
  (`Thread.tsx:642`).
- The run's first work block replaces the generic `WorkingIndicator`. Their
  heights differ slightly.

### Fixes

- Give `ChatListItem` a fixed minimum row height. Render a title placeholder
  with the same line box while the title is empty.
- Do the same for the chat header: a fixed-width title skeleton, not an
  empty span.
- Optional product choice: show the first user message as a provisional
  title until the generated title lands. That removes the empty state
  entirely.

## Issue 2 — parent looks idle while children run

### Root cause

There is one status bit: `ChatSummary.generating` and `ThreadState.generating`
both read `chats.generating`. That column tracks the chat's own turn only
(`apps/server/src/chats/thread-state.ts:45-57`). Subagent runs live in
`agent_runs` under child threads.

The server already pushes the tree to every ancestor chat
(`notifySubagentTree`, `apps/server/src/agents/tree.ts:66`). The client
throws those frames away unless the chat is open
(`use-member-socket.ts:156-157`). The sidebar uses only `c.generating`
(`chats-panel.tsx:79`).

### Fix: add a second, derived status

Keep two distinct states:

- `generating`: this chat has its own live turn. It owns the Stop button,
  the queue mode, and the "Stopping" state.
- `working`: this chat or any descendant has a queued/running run. It owns
  the spinner, the "Subagents working" block, and the busy shimmer.

Do not set `busy` from `working`. A send into a chat with no own turn is a
normal send, not a queue, and Stop must not appear.

Data sources:

- Live: keep a `Map<chatId, ChatSubagentNode[]>` from every
  `subagent_tree` frame, not only the open chat. Derive `working` from
  `isRunningStatus` over the subtree.
- First paint: add `working` to the chat list row (server query over the
  chat's thread subtree). Without it, a reload shows the sidebar idle until
  the next tree change.

### UI

- Sidebar row: show the spinner when `generating || working`. Use a
  distinct treatment for `working` if wanted (for example a slower pulse),
  so the user can tell a parent from its own turn.
- Open thread: show the `WorkingIndicator` and the "Subagents working"
  block when `working` is true. Keep the composer in send mode unless
  `generating` is true.

## Issue 3 — subagent block pops in late

### Root cause

It is a WebSocket frame, but it is the last frame in the sync bracket:

`runSyncStarted` sends `SyncBegin`, then `ThreadState` (a full thread
capture), then `SubagentTree`, then `SyncDone`
(`apps/server/src/http/ws.ts:670-692`). The client clears the list at the
start of every open (`use-thread-store.ts:147`). So the block can only
appear after the whole thread capture completes.

Two secondary problems:

- `subagent_tree` is not in `SocketGate.isLive`
  (`apps/server/src/http/ws.ts:289-296`). A live tree push can interleave
  with a sync bracket, so a bracket snapshot can overwrite a newer push.
- The client keeps no per-chat tree cache. Every navigation starts from an
  empty tree.

### Fixes

- Send `SubagentTree` before `ThreadState`, or run both reads in parallel
  and send the tree first. The tree read is small and independent.
- Keep the last tree per chat on the client, like the reducer keeps blocks.
  A revisit shows the previous tree immediately.
- Add `subagent_tree` to the sync gate's deferred live frames, or version
  the tree so an older bracket snapshot cannot overwrite a newer push.

## Issue 4 — navigation jumps and jitters

### Root causes

1. **Skeleton replaces the old view.** `openForChat` sets
   `threadLoading = !restored` and clears blocks for an unseen chat
   (`use-thread-store.ts:145-170`). The render shows `ThreadSkeleton` when
   blocks are empty (`Thread.tsx:1322`). The user sees the parent, then a
   skeleton, then the child.
2. **Header and composer flip late.** `fetchChatTree` is a separate HTTP
   call, refetched on every chat id (`use-thread-store.ts:124-143`). Until
   it lands, `readOnlyThread` is false, so the composer is editable and the
   header has no breadcrumb. Then both change.
3. **Scroll pin ignores late content.** The pin effect depends only on
   `[blocks, composerH]` (`Thread.tsx:473-484`). The subagent block, the
   compaction line, the working indicator, and images all change height
   without re-pinning. When the pane is at the bottom, content grows below
   the viewport; the next blocks update then jumps to the true bottom.
   When a block is removed, the browser clamps `scrollTop` and the view
   jumps up.
4. **Every open forces the bottom.** `openForChat` sets `stick.current =
   true` unconditionally (`use-thread-store.ts:149`). Going back to a thread
   the user had scrolled up loses the reading position.
5. **The read-only test waits for the load.** `isReadOnlyThread` returns
   false while `threadLoading` is true. That is why the composer is editable
   during the skeleton.

### Fix: one navigation transaction

The user's preference is correct: hold the old view until the new data is
ready, then swap once.

1. Separate the route target from the displayed chat. Keep rendering the
   old thread while the new one loads.
2. On a chat id change, start the socket sync and `fetchChatTree` in
   parallel. Cache the tree per chat id.
3. Mark the target ready when the first `ThreadState` for that chat arrives
   and the tree is resolved. Then swap in one commit: blocks, tree, child
   tree, title, read-only state. Pin to the bottom once, after the swap.
4. For a cold deep link or reload there is no old view. Show the skeleton,
   but do not paint the composer until the read-only state is known. A
   fixed-size header placeholder also helps.
5. Keep the scroll position per chat. Only force the bottom when the
   previous view was at the bottom, or when the chat is new.
6. Replace the `[blocks, composerH]` pin with a `ResizeObserver` on the
   content column. While `stick.current` is true, every height change
   re-pins. That covers late blocks, images, and the subagent tree.

## Suggested order

1. Stable sidebar row and header title placeholders. Small, removes the
   new-chat jump.
2. Per-chat subagent tree cache and sync-bracket reorder. Removes the late
   pop-in and enables `working`.
3. `working` status for the sidebar and the open thread.
4. Navigation transaction and cached child tree. Biggest change; removes
   the skeleton and the header/composer flips.
5. `ResizeObserver` scroll pin and per-chat scroll memory.

## Files touched by the likely fixes

- `apps/desktop/src/views/sidebar/rows.tsx`
- `apps/desktop/src/views/sidebar/chats-panel.tsx`
- `apps/desktop/src/views/thread/Thread.tsx`
- `apps/desktop/src/views/thread/status.ts`
- `apps/desktop/src/views/thread/hooks/use-thread-store.ts`
- `apps/desktop/src/views/thread/hooks/use-member-socket.ts`
- `apps/server/src/http/ws.ts`
- `apps/server/src/chats/ws-sync.ts`
- `apps/server/src/hub/feed.ts`
- `apps/server/src/platform/store/chats.ts` (optional `working` field)
