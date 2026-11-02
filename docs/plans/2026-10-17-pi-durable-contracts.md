# Pi Durable integration contracts — 0.5.71

Status: **implemented** in 0.5.71; pi-durable and pi-ai are still pinned to 1.3.0 (`apps/server/package.json`).

The server audit compared Guild at `5e6ec4a` against the Pi Durable README,
examples, and installed implementation. This change fixes its nine findings
and pins `pi-durable`, `pi-ai`, `pi-codemode`, and Chord to **1.3.0**. Pi AI is
now an explicit server dependency, matching its direct imports.

## Storage and ownership

Each Postgres `commit()` invocation receives a random identity that remains
stable across its internal retries. Its receipt commits atomically with the
writes. Both ambiguous-outcome lookup and retry inside the metadata lock
use that identity. Repeated task checkpoints or document deltas can no
longer adopt an earlier write merely because their record IDs match.

First-touch chat creation uses the public Session kernel, with the five
built-in conversation documents initialized in the creating commit. It
opens no scheduler and does not rewrite another worker's running tasks.
The later harness remains scoped to its own conversation.

## Transcript projection

`chat_entry_projections` maps each durable entry to one stable visible event.
`chat_projection_cursors` stores the completed backfill position and turn
state. An event can commit before its cursor: retry finds the same event,
so neither a process crash nor a cursor-write failure duplicates output.
Backfill reads immutable storage pages, including entries excluded from the
active context by reset or compaction.

At first backfill, a persisted boundary identifies entries eligible for
adoption of existing legacy events. Matching ignores historical turn/step
numbering, which earlier bridge restarts could change. Future entries
never adopt an unrelated older event just because their text is identical.
The boundary is separate from the advancing cursor and survives restart.
The compatibility migration also handles already initialized cursors.

The host consumes initial and overflow snapshots, restores run ownership
and live partial/tool state, and retries projection failures without
terminating agent execution. It captures the submission list and maximum
backfill entry on the Session line, so a later placement cannot be skipped
before its queued user echo is delivered. Submissions and command outcomes
are reconciled from persisted records on recovery.

Unprojected entries are pending work for server boot and worker respawn,
even when every agent task is terminal. The upgrade may therefore start
workers once for older idle conversations needing their initial backfill.
Only actual agent work triggers restart tool provisioning.

## Tools, approvals, and cancellation

- Dynamic integration and user-MCP definitions carry `callers: ["tools"]`
  when installed. Passing copied registrations to `configure()` is no
  longer relied on to change their definitions. Provider requests offer
  only codemode; nested calls still run all approval hooks.
- The base tool allow-list derives from every selected base extension,
  retaining `thread_history` and `thread_search` when integrations exist.
- Every provisioning reconciles the complete desired selection, including
  empty integration/MCP surfaces. It does not depend on process-local
  knowledge of whether a conversation was configured before restart.
- `push_skill` uses **unsafe replay**. Publication allocates a new version
  and does not have a durable external idempotency key; interruption is
  reported rather than automatically publishing another version. This
  also stops replay of old safe-intent checkpoints after the upgrade.
- Approval waiting preserves pending cards across harness close/failure.
  Only persisted task abort intent journals cancellation. Timeouts anchor
  to the original card's creation time. Existing judge metadata is read
  as JSON, allowing recovery to reuse the original verdict.
- Integration/MCP adapters propagate the call cancellation context.
  Builtin connector helpers combine it with their request deadlines using
  an async call scope; MCP handshakes and calls combine it explicitly.
  Stop cancels local in-flight HTTP requests, including nested codemode
  calls. Remote servers remain responsible for any effects already run.

## Validation

- Server typecheck passes with the pinned 1.3.0 dependency family.
- Broad run excluding the three independently reproduced baseline-failing
  files: **507 passed, 40 skipped**, across 53 passing files. The skips are
  the opt-in sandbox integration suites.
- Final targeted checks after the boot/respawn change: **36 passed** across
  seven files. These include eight worker scenarios, ten contract
  regressions, real HTTP cancellation, Postgres ambiguous commits, and
  approval approve/timeout/abort across interruption.
- The three excluded files were replayed from the starting commit in a
  detached checkout using the same dependency installation. They reproduce
  the HTTP golden `onboarded` mismatch, WS golden `last_activity_at`
  mismatch, and existing WS feed terminal-state wait failure. They were not
  silently counted as passing.
- Updated the recently added wedge diagnostic to wait for a terminal first
  run before asserting immediate placement, and corrected its mock response
  types. MCP/integration fixtures exercise the codemode path they now expose.
- Isolated the pre-existing CORS fixture with a disposable database: its
  default configuration otherwise opens the running dev database. The
  initial broad run had already populated some projection mappings there;
  a read-only check found **zero duplicate pairs**, and no duplicate-repair
  deletion was needed. Production was not accessed.
- A read-only preview inspected 172 dev conversations and 6,770 durable
  entries before shipping. It confirmed why legacy numbering must not be
  used as the identity of an existing event.

Long-run evidence is in the systemd journals for
`bigjob-20261016-214000-guild-validation`,
`bigjob-20261016-213601-guild-recovery-checks`, and
`bigjob-20261016-214400-guild-baseline`.

## Delivery

Implementation commit: `284c5a7` on `develop`, product version **0.5.71**.

- Dev compose rebuild completed successfully; `/api/v1/health` reports
  0.5.71 and the running image contains Pi Durable 1.3.0.
- The HTTP-served `index-BWjK-s0s.js` matches the rebuilt container byte for
  byte: SHA-256 `6bff96843520e7fa67ed0ec4ec53e0c452175ac170911c10fe20dd7e4f7938de`.
  Its hash is unchanged because this release changes server behavior and
  client version metadata without changing frontend logic.
- The desktop release completed successfully: six signed artifacts
  (Windows installer, Linux AppImage, two macOS DMGs, two macOS updater
  archives). All artifact metadata signatures verify. Both local and public
  updater manifests advertise **0.5.71** for all four platforms.
- The Windows installer downloaded through the public updater URL matches
  its recorded SHA-256 and Ed25519 signature:
  `d08fcc407d0bfdb045435b3828c30e3bb99be9785dd2b8eff836b1045e820219`.
- A real GLM-5.3-Flash turn used codemode to call `thread_history`, returned
  `PI_DURABLE_130_OK`, and cleared generating. Chat:
  `01a146a8-9152-786b-8997-3ded9dcb9bdc`. Its command is completed, its
  submission is done, and its cursor reaches durable entry 16220.
- After startup backfill, **zero** dev chats have unprojected entries. A
  read-only check of 5,738 mappings found **zero duplicate pairs**.
- Production was not deployed or modified. Desktop artifacts were built and
  published; native GUI execution on Windows/macOS was not performed.

Delivery journals: `bigjob-20261016-213900-guild-dev-deploy` and
`bigjob-20261016-213920-guild-dev-clients`, both exit status 0.
