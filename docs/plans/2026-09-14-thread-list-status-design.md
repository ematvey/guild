# Thread-list status — design

Date: 2026-09-14. Status: design, not built.
Feature: per-chat status in the sidebar — `generating` (spinner) /
`done+unread` (dot) / `done+read` (nothing). PLAN item 3.

## Goal

The sidebar answers two questions without opening a chat:

1. Is this chat producing a turn right now? → spinner on the row.
2. Did a turn finish that I haven't seen? → dot on the row.

Both update live, on every device the user has open, without polling.

## States and semantics

Per chat, per user:

- **generating** — a ChatRunner generation is in flight for the chat.
  Server-side truth, stored on the chat row. Rendered as a small pulsing
  spinner. Takes precedence over unread.
- **unread** — the chat is not generating and has at least one
  `assistant_message` thread event newer than the user's read marker.
  Rendered as a small dot. Only assistant turns count: the user's own
  message must not mark their own chat unread the moment they send it.
- **read** — neither of the above. No marker.

Unread is **derived at list time**, not stored: it is a pure function of
(thread_events, chat_reads, chats.generating). This keeps every turn-end
path correct by construction (no "forgot to set unread on this exit" bug
class) and gives mark-as-unread later for free (move the marker backwards).
The cost is one indexed EXISTS per chat in the list query — chats per user
are dozens, the index (`thread_events_chat_idx` on `(chat_id, id)`) serves
it, and uuid v7 ordering makes `id >` a correct time comparison.

## Data model (migration 0041)

```sql
ALTER TABLE chats ADD COLUMN generating BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE chat_reads (
    chat_id           UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    last_read_event_id UUID NOT NULL,  -- a thread_events.id (v7, time-ordered)
    PRIMARY KEY (chat_id, user_id)
);
```

- `generating` lives on the chat row: it is a property of the chat's
  workflow, identical for every device.
- Read markers are per (chat, user): an admin opening another user's chat
  never disturbs the owner's dot.

### List query

`list_chats` becomes:

```sql
SELECT c.id, c.title, c.created_at, c.machine_id, c.machine_label, c.generating,
       c.generating = false AND (
         r.last_read_event_id IS NULL OR EXISTS (
           SELECT 1 FROM thread_events e
           WHERE e.chat_id = c.id
             AND e.id > r.last_read_event_id
             AND e.type = 'assistant_message'))
       AS unread
FROM chats c
LEFT JOIN chat_reads r ON r.chat_id = c.id AND r.user_id = $2
WHERE c.org_id = $1 AND c.user_id = $2
ORDER BY c.created_at DESC
```

(`r.last_read_event_id IS NULL` covers "never opened": any assistant turn
the user never read counts — including the first reply to a chat they
abandoned mid-generation.)

`ChatSummary` (transport.ts) gains `generating: boolean; unread: boolean`.

## Lifecycle — who flips `generating`

All flips happen inside the ChatRunner workflow as **journaled steps**
(Restate step outputs are persisted; the flag survives deploys and replays
idempotently — setting it twice is harmless):

1. **generate entry** — one journaled step: `UPDATE chats SET generating =
   true` (org-scoped) + NOTIFY status frame (below). Runs before the first
   model call, so a slow provider start still shows the spinner.
2. **every exit** — one journaled step setting it false + NOTIFY. Exit
   paths enumerated: normal turn end (after the assistant event persists
   and Done broadcasts), provider/upstream error (Error frame), and the
   pre-turn terminal failures (`api_terminal_free_chat` path — the chat is
   freed there anyway; the flag must clear with it).
3. **sweep backstop** — the existing stuck-generation sweep (startup,
   `chatgen_inv:*` records) already resolves stranded workflows; it now
   also clears `generating` for the chats it resolves. A deploy that
   strands a workflow can never leave a forever-spinner.

The flag is never flipped by the in-memory generations map — that map is
per-process and dies with the process.

## Live propagation

New dedicated NOTIFY channel **`guild_chat_status`**, payload
`{org_id, user_id, chat_id, generating}`:

- **No event-log rows.** The org event log (`guild_events`) stays
  meaningful; per-turn status would flood it (2 rows per turn, all time).
  The status channel is notify-only — ephemeral by design.
- Emitted in the same transaction as the `generating` UPDATE, so no
  observer ever sees the flag and the notification disagree.
- `events/stream` adds a second `listener.listen(guild_chat_status)` and
  forwards matching frames as SSE `event("chat_status")`, filtered to the
  stream's org **and user** (chats are per-user; other members must not
  learn when someone's chat is busy). The listener already holds one
  standalone PgListener connection — a second channel costs nothing.

Every client already holds `/api/v1/events/stream` for its lifetime:

- **Web** — the connection exists but is currently drained unconsumed
  (transport.ts `startEventStream`). The design consumes it: parse
  `chat_status` frames and update the sidebar row in place; a
  `chat_status` for an unknown chat id (chat created in another tab)
  triggers one `refreshChats()`. No new connection.
- **Desktop** — the app process owns the connection and forwards frames to
  the webview over the app-frame channel. `chat_status` forwards as a
  distinguished app-frame payload `{type: "chat_status", chat_id,
  generating}` — **outside the per-chat seq watermark** (it is idempotent
  sidebar state, not conversation content; watermarking it against
  thread-event seqs would drop it). WebChat's frame router routes it to
  sidebar state by `chat_id`.

Fallback correctness: on events/stream reconnect every client re-runs
`refreshChats()` — the list carries the flags, so a missed frame heals on
reconnect.

## Read marking

- `POST /api/v1/chats/{id}/read` — org-scoped via `get_chat` (404 for
  foreign chats). Upserts the caller's marker:

  ```sql
  INSERT INTO chat_reads (chat_id, user_id, last_read_event_id)
  VALUES ($1, $2, (SELECT COALESCE(max(id), gen_random_uuid()) ...))
  ```

  concretely: marker = `SELECT max(id) FROM thread_events WHERE chat_id =
  $1` (empty thread → the marker is set on first read after a reply
  arrives; an empty thread has nothing unread anyway — the upsert simply
  no-ops into a marker of the chat's creation point; simplest correct form
  is: skip the insert when the max is NULL).

- Client calls it (fire-and-forget) when:
  1. the open chat's thread finishes loading (`applyThreadRows`), and
  2. a Done/Error frame lands for the open chat — the turn that just
     finished is the one being watched.
  Both guarded by `document.visibilityState === "visible"`: a hidden tab
  must not swallow its own unread dot. A hidden tab marks read on its next
  visible frame instead (the guard makes the call a no-op until then; the
  dot stays honest).
- Desktop uses the same two triggers (thread load + Done frame for the
  open chat) — it sees the same frames via the app-frame channel.

## Rendering

`ChatListItem` gains status props:

- `generating` → spinner (pulsing, leading edge of the row, replaces the
  dot slot).
- `!generating && unread` → dot (right-aligned, `bg-accent`, size 2).
- else → nothing.

State updates come from the live channel; `refreshChats()` remains the
reconnect/navigation catch-up, not the primary update path.

## Edge cases

- **Multiple devices**: all share one flag row and one marker row per
  user; opening the chat on any device clears the dot everywhere (the
  marker upsert NOTIFYs nothing — other devices learn on their next
  refresh; acceptable, the dot is cosmetic. If instant cross-device dot
  clearing is wanted later, a status NOTIFY on read costs one line).
- **Compaction**: appends one event; if it lands after the last read, it
  is not an `assistant_message` — no false dot.
- **Admins**: `list_chats` is own-chats only (unchanged); an admin's
  foray into another user's chat writes the admin's own marker.
- **Abandoned mid-generation chat**: user closes the tab while generating
  → flag clears at turn end, dot appears (assistant event newer than
  marker), user returns to find the answer.
- **generating=true on chat create**: impossible — flag starts false, set
  only by the workflow after the row exists.

## Future (explicitly out of scope)

- **Mark as unread** (user action): derived model supports it — move the
  marker back to before the last assistant event. UI + endpoint later.
- **Unread counts** per thread (needs a count query, not just EXISTS).
- **Order the sidebar by last activity** instead of creation time (the
  status columns make `max(thread_events.created_at)` ordering cheap, but
  it changes UX subtly — separate decision).
- **Other users' activity in admin views** (would need per-user event
  surfacing; the status channel is deliberately owner-scoped).

## Test plan

- **Store**: mark-read + unread derivation roundtrip on a fresh org —
  user-only turn → unread false; assistant turn → true; read → false;
  second assistant turn → true; generating suppresses unread.
- **HTTP**: GET /chats carries both flags; POST /chats/{id}/read is
  org-scoped and owner/admin-gated (member + foreign chat → 404).
- **Sweep**: the stale-generation sweep clears `generating` alongside its
  existing resolution (extend its existing test).
- **Events**: a `guild_chat_status` NOTIFY reaches an org-matched stream
  and is withheld for other users (extends the events_api test).
- **Worker flips** ride the Restate roundtrip tests — still `#[ignore]`d
  until the embedded runtime (PLAN item 5); the store-level functions they
  call are tested directly meanwhile.

## Rollout

One deploy. Migration 0041 is additive (new column defaults false, new
table empty) — no backfill, no dual-write window. Clients that ignore the
new fields keep working; old clients simply never clear dots they never
render.
