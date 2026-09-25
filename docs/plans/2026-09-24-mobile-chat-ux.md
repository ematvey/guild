# Mobile chat UX — issue analysis and plan

From two iPhone Safari screenshots (guild.example.com, 01:30) plus the
requirements typed into the chat itself. Analysis only — no code changed.

## UPDATE 2026-09-26: black screen root cause CONFIRMED

Reproduced headlessly against guild.example.com (desktop Chrome, mobile
viewport, session minted in the DB, test chats archived and session revoked
afterwards). A new **project** chat send crashes the app with:

```
Uncaught TypeError: Cannot read properties of undefined (reading 'machine_online')
```

WebChat.tsx composer project chip (~line 2740):

```ts
const machineOnline: boolean | undefined = remoteMachine
  ? chatId
    ? row!.machine_online        // row is undefined right after create
    : machines?.find(m => m.machine_id === chipMachineId)?.connected
  : undefined;
```

`created()` pushes the route to the new chat id before the refetched chat list
lands, so `row = chats.find(c => c.id === chatId)` is undefined and the `row!`
assertion throws during render. With no error boundary, React unmounts the
whole tree — the black screen. Non-project chats never take the `row!` branch
(no machine chip), which matches "non-project chats work". Existing project
chats have `row` present, which matches "retry from an existing chat didn't
crash".

Server-side signature of the crash (both his phone and the repro): POST
/api/v1/chats → 200, five rapid GET /api/v1/chats, then silence — the
gateway/chat submit never fires because the page died first.

The retry dead-end and "Load failed" are downstream of this crash. A desktop
retry of the same restored command through the same Cloudflare path succeeded
(gateway/chat 200 in 14ms), so the payload and the edge are fine. Still
phone-specific and unexplained: the IndexedDB write failures (storage toast,
fired pre-crash) and the retry's "Load failed" — verify on the phone after the
crash fix ships, before chasing further.

## What the screenshots show

1. In-flight send: user bubble with text + a **broken-image glyph** (Safari's
   blue `?` box), "Working" below, and a toast
   **"Files could not be saved for reloads in this browser"** overlapping the
   composer chips.
2. After the failure: thread shows **"No messages in this thread yet"** while
   the composer carries a **"Send needs retry: …" / Retry send** banner and the
   recovered text — no attachment thumb anywhere. The attachment is gone.

## Issue list

### A. The failed send (robustness)

What we reconstructed from code (pre-crash-analysis; see UPDATE above for the
confirmed primary cause):

- The send carried an image attachment. Somewhere between
  `BrowserSendStore.saveCommand` (IndexedDB) and `sendChatNoStream` the send
  failed, `failSend` removed the optimistic bubble, and `recoverOutgoing`
  restored only the text (`recoveryDraft` restores attachments only if the
  command still has them).
- **The attachment was lost permanently.** Two suspects, both real defects:
  1. **The localStorage snapshot wins over the file snapshot.**
     `rememberCommand` (outgoing-command.ts) writes a *prepared* snapshot to
     localStorage with all `file` blobs stripped — JSON can't hold them. It is
     written inside `io.submit`, just before the network call. After a page
     reload, `selectRestoredCommand` prefers whichever record has `prepared`;
     if the IndexedDB checkpoint that would also carry `prepared` failed or
     landed older, the blob-less localStorage snapshot wins. Retry then runs
     the upload branch `attachment.file ? upload : attachment.uploadedAs ??
     attachment` — no file, no `uploadedAs` — and **sends the raw local-id meta
     with a random UUID to the server**, which rejects it. The send can then
     never succeed; the banner is a dead end. The comment at that branch
     ("a file-less entry is only reusable when its upload already completed")
     describes an invariant the code does not enforce.
  2. **The IndexedDB write failed and the error was swallowed.** The toast is
     generic; `storageFailure()` keeps only a boolean and drops the actual
     exception. No console log, no telemetry. On iOS Safari IndexedDB can
     fail under storage pressure / eviction (WebKit's 7-day script-wipeable
     storage cap, ITP), and WebKit has known flaky-abort bugs mid-session —
     but we are blind to which happened here.
- The error text from the send itself (`command.error`, set by
  `submitCommand`) is **not surfaced** — the retry banner shows only the
  truncated message text. `failSend` does append an error block to the thread,
  but the thread in screenshot 2 is empty, meaning the view was reloaded
  (client-only error block vanished) or the error block landed in a different
  view. Either way, on mobile the user never learns *why*.
- Broken image glyph in the optimistic bubble: `optimisticSend` keeps
  `previewUrl` (a blob: URL) on the block attachments, and `settleOutgoing`
  **revokes** those same URLs when the command settles. Until the server echo
  replaces the optimistic block there is a window where the thumb points at a
  revoked blob URL → broken `?` image. A failure path can strand that state
  (the revoked URL may also be reached via a restored command whose preview
  was minted and then revoked by the `command !== loaded` branch in
  `restore()`).

### B. Layout issues (the requirements typed in the chat)

- **"scrollable with the ui, only content can be scrollable."** The shell is
  already `fixed inset-0` with the message pane as the only scroll container
  (`overflow-y-auto overscroll-contain`), and `useVisualViewportPin` pins the
  shell to the visual viewport while the keyboard is up. What is still wrong
  on iOS Safari:
  - The body is not scroll-locked. iOS Safari pans the *visual* viewport over
    fixed elements at scroll-chain ends (rubber-band beyond the pane, drag on
    header/composer). `overscroll-behavior` on the pane stops chaining from
    the pane, but nothing stops the page-level pan from gestures that start
    outside it. Needs `overscroll-behavior: none` on html/body plus blocking
    `touchmove` on non-scrollable surfaces.
  - `useVisualViewportPin` keys on `vv.offsetTop > 0` / height shrink. iOS
    Safari (16.4+) fires visualViewport resize/scroll for the keyboard, but
    the heuristic is fragile when the Safari bottom toolbar collapses
    (height shrink without keyboard) — it can pin the shell at the wrong
    offset and the whole UI then "scrolls" as one slab. Needs verification
    against real device logs, not assumptions.
  - The empty-thread branch (`flex flex-1 … overflow-y-auto`) is a second
    scroll container that can chain into the page.
- **"composer sidebar wraps, it cannot wrap … long badges should be replaced
  by icons."** The composer bottom row is
  `flex flex-wrap items-center justify-between` (WebChat.tsx ~2710): on a
  narrow screen the chip group (`+`, project chip "guild · devbox",
  "Approve for me") wraps onto its own line above the model selector +
  send button (visible in screenshot 2). Requirement: no wrapping; under a
  width threshold the long badges collapse to icon-only buttons
  (FolderOpen, ShieldCheck, model stays as the widest allowed element).
  Right fix is a container query on the composer card, not a viewport media
  query — the composer is `max-w-3xl` centered, so at some widths the viewport
  is wide but the card is not (that case is fine today, but container queries
  keep it correct under sidebar/resize changes).
- **Toast overlaps the composer.** Sonner is mounted `position="bottom-right"`
  (packages/ui toaster.tsx) with no mobile handling; on a phone-width viewport
  the toast covers the composer chips and the send button. Fix: `top-center`
  (or top-right) on narrow viewports via a media query in `ThemedToaster`,
  plus shorter copy for the storage toast.

### C. Confusion state: empty thread + retry banner

A failed first send leaves: chat exists (title = message slice), server thread
empty, retry banner in composer, no in-thread trace. The user cannot tell
whether the message was delivered. Options (pick one in the plan):
- Keep a "pending/failed" ghost bubble in the thread for any command with
  `error`, rendered from `outgoingRef` — thread truth stays server-owned, the
  ghost is client-only and disappears on retry success.
- Or at minimum: show the real error text in the retry banner.

## Plan (re-ordered after the root-cause confirmation)

1. **Fix the crash** (the whole game): null-safe the chip code —
   `row?.machine_online` instead of `row!.machine_online` (and audit the two
   sibling `row?`/`row!` uses in the same expression).
2. **Add an error boundary** around the chat view: a render exception must
   render an error card with a reload action, never unmount the app. This is
   the difference between a bug and a bricked session.
3. **Instrument** (small):
   - `storageFailure()` logs the real exception (`console.error` + optional
     server telemetry if a hook exists).
   - Retry banner shows `command.error` (its own line, truncate + full text in
     title) instead of only the message text.
4. **Kill the dead-end retry**:
   - Enforce the stated invariant: a file-less attachment with no
     `uploadedAs` and no server id must fail fast at retry start with a clear
     error ("attachment lost — remove it and re-attach"), never reach the
     server with a local UUID.
   - `selectRestoredCommand`: merge instead of pick — prepared/meta from the
     localStorage snapshot, file blobs from the IndexedDB record when the
     chosen one lacks them.
5. **Blob lifecycle**:
   - Revoke command-attachment previewUrls only after the server echo has
     replaced the optimistic block (hook it on the user-message event for that
     `bindPending` key), not in `settleOutgoing` unconditionally.
6. **Scroll containment**:
   - `overscroll-behavior: none` on html/body; remove the second scroll
     container from the empty-thread branch; block touchmove on shell chrome
     (header/composer) while letting the pane scroll.
   - Re-verify `useVisualViewportPin` on a real device with Safari 17/18:
     log `visualViewport` resize/scroll + offsets during keyboard
     open/close and toolbar collapse; adjust the pin heuristic to
     distinguish keyboard (large height drop) from toolbar collapse.
   - Add `<meta name="interactive-widget" content="resizes-content">` for
     Android Chrome parity (Safari ignores it; document that).
7. **Composer chips**:
   - Container query on the composer card: below a threshold render
     "Approve for me" as ShieldCheck icon-only (title keeps the label),
     project chip as FolderOpen icon-only with FadeTitle dropped, keep
     `flex-nowrap` + `min-w-0` so nothing wraps; model selector keeps text
     but with a hard `max-w` + truncate.
8. **Toasts**:
   - `ThemedToaster`: `top-center` under `max-width: 640px` (sonner accepts
     responsive config via `unstyled` styling or mount two Toasters with
     media-query CSS). Reword the storage toast: "Attachments won't survive a
     reload on this browser" (it is a warning about durability, not an error).
9. **Ghost bubble for failed sends** (the C decision) — decide after 1-2
   land; it is the only item with a real design choice.

Verification: iOS Safari (real device, not responsive mode) — send with
image on/offline, airplane-mode retry, keyboard open/close during scroll,
reload mid-send. Desktop regression: composer at 3xl and narrow-with-sidebar.

## Open questions (grill)

1. "Composer sidebar wraps" — confirm this means the bottom chip row of the
   composer (project + approval + model), not the chat sidebar drawer. Any
   chip besides "Approve for me" and the project chip that should go icon-only?
2. Which failure UX do you want: auto-retry with backoff for transient
   network errors (with an idempotency guard — `sendChatNoStream` already
   passes the client id; confirm the server dedupes on it), or keep manual
   Retry only?
3. If a file blob was lost (storage refused), is dropping the file and
   sending text-only acceptable with a warning, or must the send block until
   re-attach? (Affects item 2's fail-fast copy.)
4. Was the failed send made with the screenshot attached via paste or via the
   `+` picker — and did you background Safari before it failed? (Confirms the
   tab-suspension-killed-fetch hypothesis; iOS kills in-flight fetches on
   suspension, and the server may have received it — dedupe matters.)
5. Scroll complaint: is it (a) rubber-band of the whole page when dragging the
   message list past its end, (b) header/composer moving when the keyboard
   opens, or (c) both? Decides how aggressive item 4 gets.

## References

- MDN VisualViewport API; web.dev "Prepare for viewport resize behavior
  changes coming to Chrome on Android" (interactive-widget; Safari ignores it).
- MDN overscroll-behavior (Safari 16+); WebKit ITP script-writable storage
  7-day cap (WebKit blog, storage eviction policy).
- WebKit IndexedDB blob-storage flakiness reports (bugs.webkit.org).
- Sonner Toaster props (`position`, responsive handling).
