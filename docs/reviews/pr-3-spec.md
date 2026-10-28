# Spec review — PR 3 (wire contract), `develop` vs `master`

## (a) Missing or partial

1. **The body's schema list is wrong.** Body: "a checked contract in
   `protocol/`: `socket`, `rest`, `rpc` and `sandbox` schemas". `protocol/`
   holds only `socket`, `rest` and `rpc`. The sandbox schema and its two
   fixtures are deleted. PLAN says: "Its schema and its two fixtures are
   deleted." The body describes the old state.
2. **The sandbox does not import `@guild/wire`.** Body: "The server, the
   desktop and the sandbox import it." `rg "@guild/wire" apps/server/src/sandbox`
   finds nothing. `apps/server/src/sandbox/protocol.ts` keeps hand-written
   `SandboxClientFrame`/`SandboxAgentFrame`. This matches the PLAN (sandbox
   wire out of scope), not the body.
3. **The claimed product work is not on this line.** Body: "Ships the product
   work on this line: onboarding, machine deauthorization, the integrations
   shop, the skills bundle editor, thread type/archive/delete, routine
   delivery, and the read-mark workspace push." `git diff master...HEAD` has
   no change to `onboarding.tsx`, `http/machines.ts`, `src/integrations`,
   `views/skills` or `agents/routines.ts`. Those features are already on
   `master` (`7515dcc7 onboarding…`, `04899870 machines: deauthorize…`,
   `f5b6ba8b integrations: plugins in a shop…`, `4c5a9a76 skills: the editor
   edits the whole bundle`). Only the read-mark push (`5050f236`) is on this
   branch.

The wire items that the body does claim are present: `@guild/wire` is the one
TypeScript home; ts-rs, `check-bindings.sh` and `crates/protocol/bindings` are
gone; `jsonbText`/`recordJsonText` live in `platform/domain/text.ts` with a
Postgres test; `record::jsonb` is gone outside the retired migration (a source
test guards it); the attachment author fix is in `0099_attachment_author.sql`
and `AttachmentStore.create`; `rustJsonText` is deleted.

The read-mark push is real, not a poll. `markRead` runs
`pg_notify('guild_workspace', …)`; `hub/feed.ts` calls `pushWorkspace`, which
emits `thread_list`; `socket-client.ts` handles `case "thread_list"` through
`onThreadList`.

## (b) Scope creep

- `b3aa07e0 brand: new hexagonal G icon` — every icon and favicon asset. Not
  in the body.
- `10c21559 desktop: grant the window title permission` — capabilities change.
  It also bumps the version to `0.6.35`.
- Trace payload deltas: `1929a186`, `b51ef369`, `ea05c8c5`, `a4464e7e` plus
  `docs/handoff-trace-payload-deltas.md`. This is 185 lines in `trace.ts` and
  changes in `openai.ts` and `approvals.ts`. It is a separate feature with its
  own handoff doc. The body never mentions it.
- `release: 0.6.32` and `release: 0.6.33`.

## (c) Looks implemented but wrong

- **The plan contradicts the branch.** `docs/plans/2026-10-28-wire-domain-model.md`
  says "Status: **analysis not started**", "The analysis comes first. The
  edits follow from it", and lists the `Chat` split as open: "Is `Chat` one
  concept or two… The `type` / `archived` / `deleted` fields are the open
  edge." The branch already decided it (`33a04b29 protocol: one chat row, one
  builder`) and made those three fields required. The edits came before the
  analysis the plan requires.
- **RPC is out of scope in the plan.** Plan: "Out of scope … The JSON-RPC
  envelope: the desktop and the engine release together." The branch adds
  `protocol/rpc.schema.json` and three fixtures.
- **A trace delta loses non-message fields.** `recordPayload` stores only
  `parsed["messages"] = messages.slice(prefix)`. `rebuildRequest` rebuilds
  `base` from the root and pushes each delta's `messages`. A later request
  that changed `tools` or `model` keeps the root's values. The handoff doc does
  not list this limit.
- **A truncated delta breaks the chain.** `row["body"] = JSON.stringify(parsed).slice(0, MAX_PAYLOAD_CHARS)`
  can cut JSON mid-value. `rebuildRequest` then throws and its `catch` returns
  `chain[0].body`, the leaf tail only. The full-body slice has the same edge.

## (d) Commit count

The body says 40; the branch has 53. The 13 newest commits were added after
the body. Subjects that do not fit the "What" list:

- `a4464e7e`, `ea05c8c5`, `b51ef369`, `1929a186` (trace payload) — no, a
  separate feature.
- `b3aa07e0` (brand) — no.
- `10c21559` (window title permission) — no.
- `bd313b23`, `b73e0c2f` (release bumps) — release housekeeping, not the
  wire contract.
- `6ab05025 onboarding: name the real controls` — it fits the body's
  "onboarding" claim, but it has no net diff against `master`, so it belongs
  to the master line.

VERDICT: CHANGES
