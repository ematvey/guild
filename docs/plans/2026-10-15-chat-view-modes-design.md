# Chat view modes — casual / technical + hover timestamps

Grill outcome 2026-10-15 (maintainer). Header menu, two view modes, hover
timestamps. All decisions below are settled; implementation follows this doc.

## Header kebab menu

- Vertical three-dots (`EllipsisVertical`) at the right end of the thread
  header, next to the title. Disabled when no chat is open.
- Items: **Rename**, **Archive** — the same actions/transport the sidebar
  rows use. Rename opens a **popup dialog** with the name field (not inline).
  Archive flips to **Unarchive** when the open chat is archived; archiving
  the open chat **navigates to the chats list** (staying on an archived
  thread is a dead end).
- After a divider: view-mode picker — two items, **Casual view** and
  **Technical view**, check mark on the active one.

## View mode persistence

- Per user, **server-side**: new `user_kv` table (user-scoped mirror of
  `org_kv`, migration 0071), `UserKvStore` wired into the identity lane.
- `GET /api/v1/me/settings` → `{ chat_view: "casual" | "technical" }`
  (absent key = the default **`"casual"`**); `PUT` the same shape. Client
  loads on mount, toggles optimistically and PUTs.

## Technical view

- Exactly today's rendering. No changes.

## Casual view

Casual **only affects thinking/tool blocks**. Everything else keeps its
current rendering:

- User messages: unchanged, **attachments (images/file chips) stay**.
- Agent text paragraphs: unchanged style — intermediate (between-runs) and
  final text look the same; the decoration is the worked-for block, not the
  text's look.
- **Worked-for block** (casual-only) replaces each contiguous run of
  thinking + tool blocks (tool errors included):
  - while running: pulsing **"Agent is working Ns"** — no ellipsis, the
    pulse carries liveliness, seconds count up;
  - when the run completes: **"Agent worked for S seconds"**;
  - **larger vertical spacing** around this block than the default
    paragraph gap;
  - **pure-text turns get no block** — no pre-token indicator in casual;
  - one block per contiguous run (a turn may show several).
- **Pending approval cards stay visible** (a hidden gate is a stuck turn);
  resolved approvals are already dropped by the reducer.
- **Compaction cards hidden** (machine bookkeeping).
- **Terminal turn errors shown, bare** — error notice without the details;
  intermediate tool errors hidden with the rest of the tool machinery.

## Hover timestamps (both views)

- Attach to **user bubbles and agent text paragraphs only** — not to tool
  frames, reasoning, or cards.
- The strip is **always in the DOM, hidden until hover** (opacity),
  **absolutely positioned below the message** — right-aligned under user
  bubbles, left-aligned under agent text — tucked into the existing
  inter-message gap. **Zero layout shift in any state.**
- Format, locale-aware (browser timezone), shortest unambiguous form:
  - today → time only;
  - this year → "Oct 15, 14:32" style;
  - previous years → "Oct 15, 2025, 14:32" style.
- Data: reducer stamps blocks with their source event row's `created_at`
  (tool/reasoning already carry `ts`; **assistant text blocks need the
  stamp added**). Blocks without a stamp (streaming tail, optimistic
  pending sends) show no strip until they land durably.

## Implementation calls left to the builder (no user input needed)

- Rename dialog reuses the shared Dialog component.
- Hover strip is a desktop nicety; on touch it simply never shows.
- Queued-send chips (above the composer) are unaffected by view mode.
- Key name in user_kv: `chat_view`.
