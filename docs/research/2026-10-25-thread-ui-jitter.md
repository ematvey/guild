# Thread UI jitter and subagent status — full inventory

Date: 2026-10-25
Scope: desktop thread view, member socket, chat status, subagent tree,
sidebar, composer.
Evidence: two screen recordings (new chat, subagent navigation), the dev
database, and the code paths below.

## Bottom line

The four reported defects are real. They are not the only ones.

The thread view has three structural problems:

1. **Navigation is not atomic.** The route changes first. The thread content,
   the child tree, the subagent tree, and the title arrive later. Each one
   paints on its own. The user sees a skeleton, then content, then a header
   change, then a composer change.
2. **The view is not pinned by geometry.** The bottom pin runs only when the
   block list or the composer height changes. Late blocks, removed blocks,
   window resizes, sidebar resizes, and mobile keyboards all move the content
   without a re-pin.
3. **Every stream event re-renders the whole view.** The transcript, the
   sidebar, and the composer re-render on each delta. Markdown re-parses,
   timestamps re-format, and the scroll pin forces a layout. On a long thread
   this drops frames, and dropped frames read as jitter.

The list below covers every source found. Severity is about how visible the
effect is in normal use.

## Coverage of the original request

All four reported items are investigated. Two parts are still thin.

| # | Original report | Covered | Where | Still thin |
|---|---|---|---|---|
| 1 | New chat jitters, UI jumps | Yes | Video frames, A1, A6, C1, C2, C3, D5, F1, F5 | The first-send flow (scratch surface to created thread) has no separate frame-by-frame check. |
| 2 | Thread works through subagents but status is idle | Yes | DB evidence, C4, D1, E10, fix section 3 | The other status surfaces are not enumerated: Work panel, project header, rail badges, archived rows. |
| 3 | Subagent block pops in late; should arrive over WebSocket | Yes | A4, C5, C6, E15 | The answer is stated in the causes, but there is no one-line answer: it does use the WebSocket. |
| 4 | Navigation jumps; prefer to block until data arrives | Yes | A1–A9, B1–B8, C7, C8, fix section 2 | The "block the transition" rule has no acceptance criteria or tests yet. |

### Item 2 gap: the status surfaces

`generating` is read in these places. Each one needs the new `working` state
or an explicit decision to leave it out:

- Chats panel rows (`chats-panel.tsx:79`).
- Work panel rows (`work-panel.tsx:105`).
- Work panel tab aggregate (`work-panel.tsx:79`).
- Project header aggregate (`rows.tsx:248`).
- Open thread busy state (`Thread.tsx:196-197`).
- Composer send mode (`Thread.tsx:1904`). This one must stay on
  `generating`, not `working`.

### Item 3 answer

Yes, the subagent tree uses the member WebSocket. It is a `subagent_tree`
frame. It arrives late for two reasons: the client clears it on every open
(A4), and the server sends it after the full thread capture (C5).

### Item 4 acceptance criteria

The rule "block the transition until all data arrives" needs a testable
shape:

- The old thread stays visible until the target chat's first `ThreadState`
  and its child tree are both in.
- The swap is one commit: blocks, tree, child tree, title, read-only state.
- No skeleton is shown when a previous thread was visible.
- A cold deep link may show a skeleton, but the composer does not flip.
- The scroll lands once, after the swap.

## Confirmed evidence

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

## Complete jitter inventory

### A. Navigation transition

**A1 — Skeleton replaces the visible thread. (High)**
`openForChat` sets `threadLoading` and clears the blocks for an unseen chat
(`use-thread-store.ts:145-170`). The render shows `ThreadSkeleton` when the
blocks are empty (`Thread.tsx:1322`). The user sees the parent, then a
skeleton, then the child. The user asked to hold the old view until the new
one is ready.

**A2 — Child tree is fetched after the thread. (High)**
`fetchChatTree` is a separate HTTP call. It is refetched on every chat id and
not cached (`use-thread-store.ts:124-143`). Until it lands:
- the header has no breadcrumb,
- `readOnlyThread` is false, so the composer is editable,
- the child title is absent.
Then all three change at once. Repeat visits pay the same cost.

**A3 — Read-only test waits for the load. (High)**
`isReadOnlyThread` returns false while `threadLoading` is true or while
either chat list is null (`status.ts:38-41`). That is why the composer is
editable during the skeleton. It also means any resync (tab wake, reconnect)
can flip a child thread back to writable if the child tree is not loaded.

**A4 — Subagent tree is cleared on every open. (High)**
`openForChat` calls `setSubagentNodes([])` (`use-thread-store.ts:147`).
The "Subagents working" block disappears on navigation and pops back when
the sync bracket delivers the tree. This is the delayed pop-in in issue 3.

**A5 — Navigation forces the bottom. (High)**
`openForChat` sets `stick.current = true` and `atBottom = true`
(`use-thread-store.ts:149`). Going back to a thread the user had scrolled up
loses the reading position. Parent → child → back always lands at the
bottom.

**A6 — Cached empty thread flashes a skeleton. (Medium)**
`openForChat` sets `threadLoading = !opened.restored`. `restored` means
"the cached view has at least one block" (`thread-reducer.ts:1065-1085`).
A thread that was previously opened and is empty has a cached view with no
blocks. Every revisit flashes the skeleton. The cache should report
"synced", not "non-empty".

**A7 — Busy flag is cleared on navigation. (Medium)**
`openForChat` calls `markBusy(false)`. When the user opens a chat with a
running turn, the composer shows Send, not Stop, until the sync arrives.
The same happens on `onConnect` (`use-member-socket.ts:127`).

**A8 — Context revision is not reset. (Low)**
`contextRevision` is per chat. It is not cleared on navigation. The context
ring can show the previous chat's revision for one paint.

**A9 — Cache eviction. (Low)**
The reducer keeps 20 views (`thread-reducer.ts:752`). Opening a 21st chat
evicts the oldest. Going back to an evicted chat shows a skeleton.

### B. Scroll pinning

**B1 — Pin depends only on blocks and composer height. (High)**
The pin effect is `useLayoutEffect(..., [blocks, composerH])`
(`Thread.tsx:473-484`). It ignores:
- the subagent tree,
- the compaction line,
- the working indicator,
- the machine banners,
- window and pane resize,
- sidebar and column width changes.
Any of these changes the content height without a re-pin. The view ends up
above the true bottom. The next block change then jumps to the bottom.

**B2 — Removing a tail block clamps the scroll. (High)**
When the last subagent finishes, the "Subagents working" block is removed.
If the view was at the bottom, the browser clamps `scrollTop` and the view
jumps up. The same happens when the working indicator or the compaction line
disappears.

**B3 — Working indicator disappears without a block change. (Medium)**
`streaming` can flip to false while `blocks` keeps the same reference. The
indicator is removed, the tail shrinks, and no pin runs. The view jumps up.

**B4 — Resizes reflow without a re-pin. (High)**
The pane is not observed for size changes. These all change the content
height with no pin:
- window resize,
- sidebar collapse/expand (150 ms width transition),
- chat column drag (150 ms max-width transition),
- the mobile keyboard (visual viewport pin).
While the view is at the bottom, the last line drifts during the transition.

**B5 — Composer height changes in two steps. (Medium)**
`setPending([])` removes the attachment strip at once. The textarea height is
reset in `requestAnimationFrame(autoGrow)` (`use-outgoing.ts:106`, `:134`,
`:158`, `:208`; `use-composer.ts:228`). The composer shrinks twice, and the
pin runs twice. The content moves in two steps.

**B6 — Composer height starts at a guess. (Low)**
`composerH` starts at 128 px and is corrected by a `ResizeObserver` after the
first layout (`Thread.tsx:255-261`). On a cold load the content padding
starts 128 px and then shrinks. The pin corrects it, but the first paint is
wrong.

**B7 — Top insertion can move the viewport. (Low)**
The "Load earlier messages" button and a prepended page are inserted above
the viewport. The anchor effect corrects the position (`Thread.tsx:487-493`),
but the correction runs after the pin. On a short thread the auto-load can
fire during the open, and the view moves down by one page.

**B8 — Browser scroll anchoring can fight the explicit pin. (Low)**
The pane does not set `overflow-anchor: none`. The browser may adjust
`scrollTop` when content above the viewport reflows. The app also sets
`scrollTop` itself. The two corrections can disagree.

### C. Async state flips

**C1 — Title arrives late. (High)**
The header shows an empty span until the chat row or the title push arrives
(`Thread.tsx:642`). The sidebar shows an empty-title row. This is the new
chat jump in issue 1.

**C2 — Empty-title row is shorter. (High)**
The empty `FadeTitle` has no line box. The row is 26 px instead of 32 px.
Every row below shifts by 6 px when the title lands. The spinner also jumps
from the left edge to the right edge.

**C3 — New chat inserts a sidebar row. (Medium)**
`refreshChats` runs after the create. The new chat is inserted at the top of
Recents. All rows below shift down by one row height. The shift is expected
but it is still a jump.

**C4 — `generating` covers only the chat's own turn. (High)**
`ChatSummary.generating` and `ThreadState.generating` read `chats.generating`
(`thread-state.ts:45-57`). A parent with running children is idle by that
flag. The sidebar shows no spinner and the open thread shows no busy state.
This is issue 2.

**C5 — Subagent tree is last in the sync bracket. (High)**
`runSyncStarted` sends `SyncBegin`, `ThreadState`, `SubagentTree`,
`SyncDone` (`http/ws.ts:670-692`). The tree read is small and independent,
but it waits for the full thread capture. This is issue 3.

**C6 — Subagent tree is not deferred during sync. (Medium)**
`SocketGate.isLive` defers `live_frame`, `chat_status`, `org_event`, and
`error` (`http/ws.ts:289-296`). It does not defer `subagent_tree`. A live
tree push can interleave with a sync bracket. An older bracket snapshot can
overwrite a newer push.

**C7 — Reconnect rebuilds the view. (Medium)**
`onConnect` calls `reducerRef.current.invalidate()` and `markBusy(false)`
(`use-member-socket.ts:125-128`). The next sync rebuilds every view from its
event window. Expanded work frames collapse. The composer flips to Send
until the sync restores the turn.

**C8 — Archived list is a second async gate. (Medium)**
`isReadOnlyThread` needs both `chats` and `archivedChats` to be non-null.
If the archived fetch fails, the list stays null and a child thread stays
writable. If it lands late, the read-only state flips late.

**C9 — Machine banner appears from the list, not live. (Medium)**
`offlineMachine` reads `machine_online` from the chat list
(`status.ts:15-25`). The banner appears or disappears on a list refresh. It
adds a row above the pane and shifts the whole thread down or up with no
re-pin.

**C10 — Machine-taken-over banner. (Low)**
The same layout effect as C9, from the socket presence state.

**C11 — Deploy auto-reload. (Medium, occasional)**
The view polls the served bundle every 60 s and reloads when the hash
changes and the app is idle (`Thread.tsx:341-368`). A deploy during a session
resets the page, the scroll position, and the expanded blocks.

**C12 — Onboarding auto-push. (Low)**
If `onboarded` is false, an effect pushes `/onboard` after the first paint
(`Thread.tsx:461-464`). The chat view is replaced.

### D. Sidebar ordering

**D1 — Live re-sort by activity. (High)**
`sidebarGrouping` sorts by `last_activity_at` (`projects.ts:24-57`).
`applyHistory` and `onThreadEvents` move that stamp on every event
(`use-member-socket.ts:88-105`, `:166-180`). A background chat can jump above
the chat the user is reading. Rows move under the cursor.

**D2 — Project binding moves a row between lists. (Medium)**
`applyHistory` writes `project_id` from `ThreadState`. A chat that gains a
project leaves Recents and appears under the project fold-out. The row
disappears from one place and appears in another.

**D3 — Thread-list push reorders rows. (Medium)**
`onThreadList` replaces the list (`use-member-socket.ts:143-149`). The client
re-sorts. Any activity change since the last push lands as a reorder.

**D4 — Project fold-out first page reorders. (Low)**
`PROJECT_PAGE_INITIAL = 5` (`projects.ts:63`). A re-sort changes which five
chats are visible in a project fold-out.

**D5 — Skeleton row height differs. (Low)**
`ChatsPanel` renders `h-8` skeleton rows (`chats-panel.tsx:71`). A real row
with an empty title is 26 px. The list shifts when the real data lands.

### E. Performance-induced jank

These sources do not change the layout by themselves. They drop frames.
Dropped frames read as jitter, especially during a running turn.

**E1 — Whole transcript re-renders on every delta. (High)**
`transcriptEntries` depends on the whole `blocks` array
(`Thread.tsx:781`). Each stream delta and each `ThreadState` publish creates a
new array. The whole transcript element list is rebuilt. React then
reconciles every block.

**E2 — `viewEntries` recomputes on every delta. (High)**
`displayEntries = useMemo(() => viewEntries(blocks), [blocks])`
(`Thread.tsx:690-715`). It walks the full block list on every delta.

**E3 — Markdown re-parses every text block. (High)**
Each text block renders `<Markdown>{text}</Markdown>` (`Thread.tsx:763-768`).
The elements are recreated on every delta, so every settled markdown block
is parsed again. A long thread with tables and code blocks pays this cost on
every token.

**E4 — `WorkedForBlock` memo is defeated. (High)**
`WorkedForBlock` is memoized (`worked-for-block.tsx:85`), but its `run` prop
is a new array from `viewEntries` and its `children` are new elements. The
memo never hits during streaming.

**E5 — Timestamps re-format on every render. (Medium)**
`HoverStamp` calls `prettyStamp` in render (`blocks.tsx:90-104`).
`prettyStamp` creates a `Date` and calls `toLocaleTimeString` and
`toLocaleDateString` for every message. A long thread does this for every
message on every delta.

**E6 — Thinking preview re-normalizes the whole text. (Medium)**
`ReasoningFrame` runs `text.replace(/\s+/g, " ").trim()` on every render
(`blocks.tsx:31`). The live thinking block changes on every delta.

**E7 — Code highlighting re-tokenizes. (Medium)**
`highlightJs` runs a regex pass over the whole script on every render
(`js-highlight.ts:59`). A live codemode block re-tokenizes on every delta.

**E8 — One-second timer re-renders all tools in a run. (Medium)**
`WorkedForBlock` updates `nowMs` every second while active
(`worked-for-block.tsx:89-96`). All child tool frames re-render every second,
even when nothing changed. A 50-step run pays this 50 times per second of
work.

**E9 — Sidebar re-renders on every delta. (High)**
`ChatsPanel` is not memoized. The callbacks passed to it are new functions
on every render. The whole sidebar list re-renders on every stream delta.
`WorkPanel` and `SettingsPanel` have the same shape.

**E10 — Sidebar re-sorts on every event. (High)**
`grouping = useMemo(..., [chats, chatStatus])` (`Thread.tsx:792-795`).
`setChats` creates a new array on every event (activity stamp) and
`setChatStatus` creates a new object on every state. The sort runs on every
event.

**E11 — Status and chat state are new objects every event. (Medium)**
`applyHistory` builds a new `chatStatus` object and a new `chats` array for
the chat (`use-member-socket.ts:83-105`). This forces the grouping memo and
the sidebar to re-render.

**E12 — Context revision state changes every event. (Medium)**
`updateContextRevision` sets a new `{chatId, seq}` on every newer event
(`use-thread-store.ts:80-84`). The whole `ThreadView` re-renders for the
context ring.

**E13 — Draft GC runs on every event. (Medium)**
The `gcDraftKeys` effect depends on `[chats, archivedChats]`
(`Thread.tsx:518-523`). `chats` changes on every event. `gcDrafts` iterates
localStorage, and the scoped storage rebuilds the key list on every
`key(i)` call (`drafts.ts:45-58`, `:87-100`). That is O(n²) synchronous work
on the main thread.

**E14 — Forced layout on every delta. (High)**
The pin effect reads `el.scrollHeight` and writes `el.scrollTop` on every
`blocks` change (`Thread.tsx:482`). That is a synchronous layout per delta.
With E1–E3 it is the main reason a long thread stutters.

**E15 — Server republishes full views on a 100 ms poll. (Medium)**
`FeedForwarder.publishDirtyViews` runs every 100 ms and sends a full
`ThreadState` when the capture changes (`hub/feed.ts:82`, `:229-259`). The
live thinking stamp changes about 10 times per second. Each publish triggers
the client's full-view path.

**E16 — Live tool frames mutate the block array. (Medium)**
`applyFrame` for `tool_started` and `tool_completed` mutates the tool object
and the block array in place (`thread-reducer.ts:1220-1250`). `setBlocks`
receives the same array reference, so React may skip the render. The status
pill then updates only on the next delta, state, or the 1 s timer. This is a
latency bug, not a jump, but it makes the live view feel uneven.

**E17 — First sync rebuild resets expanded frames. (Low)**
When a view was built from live frames before its first sync, `applyState`
calls `rebuild` (`thread-reducer.ts:1103-1114`). All block keys change.
Expanded reasoning and work frames collapse.

### F. Cold load

**F1 — Font swap. (High on cold load)**
`@fontsource-variable/inter` and `jetbrains-mono` are imported with
`font-display: swap` (`theme.css:6-7`). The first paint uses the system font,
then Inter replaces it. Text metrics change and the whole layout reflows.
There is no preload link in `index.html`. On the tunnel this is visible.

**F2 — Sidebar skeleton to real list. (Medium)**
`loadingChats` shows five skeleton rows (`chats-panel.tsx:67-72`). The real
list has different row heights and a different length.

**F3 — Late lists add controls. (Low)**
`projects`, `archivedProjects`, `machines`, `models`, and `agentsList` load
after the first paint. The project chip, the machine dot, the model label,
and the agent label appear later. Width changes only, unless the row wraps.

**F4 — Skeleton and content use different padding. (Low)**
`ThreadSkeleton` uses `px-5` (`blocks.tsx:18`). The thread column uses `px-4`
(`Thread.tsx:1356`). The content shifts 4 px horizontally when it lands.

**F5 — Empty state to scroll pane. (Low)**
With no blocks, the view renders a centered empty state. With one block, it
renders the scroll pane (`Thread.tsx:1319-1404`). The first message of a
chat changes the structure.

**F6 — Header skeleton to title. (Low)**
The header shows a `w-28` skeleton while the thread loads
(`Thread.tsx:1247-1251`). The row height is stable because the buttons set
it, but the title pops in.

### G. Mobile

**G1 — Visual viewport pin. (Medium)**
`useVisualViewportPin` sets the shell height when the keyboard opens
(`use-visual-viewport-pin.ts`). The pane shrinks. The pin effect does not
observe the pane, so the thread is no longer at the bottom.

**G2 — New chat focus. (Low)**
`newChat` focuses the textarea before the route effect runs
(`Thread.tsx:575`). On mobile this opens the keyboard during the navigation,
so the shell and the pane resize while the route is still settling.

**G3 — Touch scroll blocking. (Not jitter)**
The shell blocks touch moves outside `data-scrollable` elements
(`Thread.tsx:317-336`). The sidebar list is not marked `data-scrollable`.
This can make the sidebar feel stuck. It is not a layout jump, but it is
part of the movement problems.

### H. Related correctness notes

**H1 — Read-only depends on two lists. (Medium)**
A failed `listArchivedChats` leaves `archivedChats` null forever. A child
thread then stays writable if the child-tree fetch also fails.

**H2 — `onChatStatus` is ignored. (Info)**
The member socket drops `chat_status` frames (`use-member-socket.ts:152`).
Status comes from `ThreadState` instead. This works, but it means the status
lane depends on the 100 ms view poll (E15).

**H3 — Same-array mutation in the reducer. (Medium)**
See E16. Several live paths mutate `v.blocks` in place. The React state
contract expects a new reference. The view can lag one frame or one second.

## Suggested fixes, grouped

### 1. Stable geometry (small, high value)

- Give `ChatListItem` a fixed minimum height. Render a title placeholder with
  a line box while the title is empty.
- Give the chat header a fixed-width title placeholder.
- Match the skeleton padding to the content padding.
- Keep the skeleton row height equal to the real row height.

### 2. Atomic navigation (medium)

- Keep the current thread visible while the target loads.
- Fetch the child tree in parallel and cache it per chat id.
- Mark the target ready when `ThreadState` and the child tree are both in.
- Swap blocks, tree, child tree, title, and read-only state in one commit.
- Do not force the bottom on a revisit. Store the scroll position per chat.
- For a cold deep link, show the skeleton, but do not paint the composer
  until the read-only state is known.

### 3. Status model (medium)

- Add `working` = own `generating` or any queued/running descendant.
- Keep `generating` for Stop, queue mode, and "Stopping".
- Keep a per-chat subagent tree map from every `subagent_tree` frame.
- Use `working` for the sidebar spinner and the open-thread busy state.
- Add `working` to the chat list row for the first paint after a reload.

### 4. Subagent tree delivery (small)

- Send `SubagentTree` before `ThreadState` in the sync bracket, or read both
  in parallel and send the tree first.
- Cache the last tree per chat on the client. Do not clear it on open.
- Add `subagent_tree` to the sync gate's deferred frames, or version it.

### 5. Geometry-aware pinning (small)

- Observe the content column and the pane with a `ResizeObserver`.
- While the user is at the bottom, re-pin on every height change.
- Re-pin after the composer, banners, and the subagent block change.
- Consider `overflow-anchor: none` on the pane, because the app sets the
  scroll position itself.

### 6. Performance (medium)

- Split the transcript into settled blocks and a live tail. Memoize each
  settled block by content.
- Stop rebuilding the whole element list on every delta.
- Cache `prettyStamp` results.
- Do not re-normalize the whole thinking text on every render.
- Memoize the sidebar and its callbacks.
- Stop the `gcDraftKeys` effect from running on every event.
- Batch status updates, or compare before creating a new object.
- Make the reducer return a new `blocks` array for live mutations.
- Reduce the full-view republish rate, or let the client apply only the
  changed tail.

### 7. Cold load (small)

- Preload the Inter and JetBrains Mono files, or use `font-display: optional`.
- Delay the project chip and machine dot until their lists settle, or keep
  their space reserved.

## Suggested order

1. Stable sidebar row and header title placeholders.
2. Per-chat subagent tree cache and sync-bracket reorder.
3. `working` status.
4. Atomic navigation and cached child tree.
5. `ResizeObserver` pin and per-chat scroll memory.
6. Transcript performance split.
7. Cold-load font and skeleton polish.

## Files touched by the likely fixes

- `apps/desktop/src/views/sidebar/rows.tsx`
- `apps/desktop/src/views/sidebar/chats-panel.tsx`
- `apps/desktop/src/views/thread/Thread.tsx`
- `apps/desktop/src/views/thread/status.ts`
- `apps/desktop/src/views/thread/blocks.tsx`
- `apps/desktop/src/views/thread/hooks/use-thread-store.ts`
- `apps/desktop/src/views/thread/hooks/use-member-socket.ts`
- `apps/desktop/src/views/thread/hooks/use-composer.ts`
- `apps/desktop/src/views/thread/hooks/use-outgoing.ts`
- `apps/desktop/src/views/worked-for-block.tsx`
- `apps/desktop/src/lib/thread-reducer.ts`
- `apps/desktop/src/views/projects/projects.ts`
- `apps/server/src/http/ws.ts`
- `apps/server/src/chats/ws-sync.ts`
- `apps/server/src/hub/feed.ts`
- `apps/server/src/platform/store/chats.ts` (optional `working` field)
