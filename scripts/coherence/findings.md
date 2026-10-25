# Coherence findings — 2026-10-25

First pass of the decoherence method on Guild. The model is committed; the
mechanical findings are fixed; the design findings need a human answer.

## Report

```
read:       AGENTS.md, PLAN.md, docs/PRD.md, docs/SRS.md, README.md,
            crates/{protocol,guild-core,app-server}/src,
            apps/server/src/{platform,harness,chats,hub,agents,http,sandbox,importer},
            apps/desktop/src/{lib,views/thread,views/agents,views/skills,views/settings},
            packages/ui/src
model:      63 concepts added, 0 changed (5 fragments: protocol, engine,
            server-core, desktop, ui-kit)
findings:   7 mechanical, 8 design
fixed:      7
floor:      files 531->531  loc 122419->122389  seams 0->0  shims 19->19
            duplicates 0->0  gaps 30->30  unmodeled 0->0  unmapped 215->215
proposed:   8
verified:   check.py check | apps/desktop tsc --noEmit | apps/server tsc --noEmit
            apps/desktop vitest 513 passed | arch-layers.test.ts 6 passed
```

## Fixed (mechanical)

1. **Four byte-size formatters, one concept.** `formatBytes` in
   `views/agents/TraceDetail.tsx`, `formatFileSize` in
   `views/agents/agents-route.ts`, `formatSize` in `views/device-setup.tsx`,
   `formatSize` in `apps/server/src/chats/spill.ts`. The first three are UI
   text with the same shape. They now call `apps/desktop/src/lib/format.ts`,
   which also carries the `binary` variant (KiB/MiB) that device setup needs.
   The server one stays: it writes model-facing pointer text, not UI text.
2. **Two homes for the session token.** `views/settings/admin-api.ts` declared
   its own `TOKEN_KEY`, `getToken`, `setToken`, `clearToken` beside the real
   ones in `lib/session.ts`. It now imports and re-exports them.
3. **Raw localStorage keys in `App.tsx`.** `"guild.serverUrl"` and
   `"guild_token"` were written by hand next to the named helpers. Added
   `SERVER_URL_KEY`; `App.tsx` uses it and `setToken`.
4. **`initialsOf` vs `initials`.** Two functions, names one letter apart, two
   different rules (first two characters vs word initials). The skill-detail
   one is now `avatarChip`.
5. **`InMemoryHub`** (`apps/server/src/hub/index.ts`) had no importer, not
   even a test. Deleted with its "kept for the M3 harness lane" comment.
6. **Dead UI files.** `packages/ui/src/components/{caret,scroll-area,separator}.tsx`
   had zero importers; deleted, with the two Radix dependencies they alone
   used. `apps/desktop/src/views/projects/ProjectPickerDialog.tsx` likewise.
7. **Stale paths in comments.** Three comments pointed at
   `apps/desktop/src/lib/context.ts`, which no longer exists. They now name
   `lib/turn-context.ts` (and `lib/skills.ts` for discovery).
   `apps/server/src/importer/cli.ts` pointed at `apps/server/M3-REPORT.md`,
   which does not exist.

## Proposed (design — not applied)

```
FINDING:  Two vendored crates are in the workspace and no crate imports them
PATTERN:  duplicate (a second exec-policy design)
WHERE:    crates/codex-execpolicy (3965 LOC with tests),
          crates/codex-utils-absolute-path
COST:     `cargo test --workspace` builds and runs them; the real gate is
          apps/server/src/execpolicy/ in TypeScript. A reader sees two
          exec-policy implementations and no rule for which one runs.
OPTION A: Delete both crates and their Cargo entries. Removes ~4k LOC and
          two test suites; docs/deploy-nuances.md drops the version note.
OPTION B: Keep them and say in AGENTS.md that they are vendored for the
          daemon and currently unimported.
ASK:      Is a Rust-side policy evaluation still planned?
```

```
FINDING:  1.1 MB of untracked test data under a crate that is not a member
PATTERN:  seam (expired)
WHERE:    crates/server/data-test/workspaces/** (gitignored, 0 tracked files)
COST:     It looks like part of the tree and is not. The directory name
          suggests a crate that no longer exists.
OPTION A: Delete the directory; the ignore rule stays.
OPTION B: Keep it for the data-test fixtures and document where it comes
          from.
ASK:      Anything in there you still need?
```

```
FINDING:  17 deprecated route aliases ride the same handlers, unmarked
PATTERN:  seam
WHERE:    apps/server/src/platform/http/chats.ts:175-548
          apps/server/src/platform/http/attachments.ts:31,66
          apps/server/src/platform/http/gateway.ts:21
COST:     Every reader must learn which of /api/v1/chats and /api/v1/threads
          is current, and whether either can be deleted. Nothing records who
          depends on the old one or when it goes.
OPTION A: Mark each alias with coherence:seam (owner, delete date, reason
          "shipped clients embed their transport"). No code change; the debt
          becomes visible and expirable.
OPTION B: Drop the aliases now. Breaks every installed client that has not
          updated; the client release cadence decides the date.
ASK:      Which desktop version is the oldest one you still support?
```

```
FINDING:  Build-milestone vocabulary (M3-M8) is still the name of live code
PATTERN:  no-home
WHERE:    47 comments, e.g. apps/server/src/platform/root-context.ts:77,90,
          106,123,128; apps/server/src/harness/runtime.ts:196,442,831,1611
COST:     The words name a plan that is not in the tree. A new reader cannot
          look them up, and "M5 hub core" is not a thing the code is.
OPTION A: Rewrite each to name the module it means ("the member socket feed",
          "the approval gate"). Mechanical, 47 comment edits, no behaviour.
OPTION B: Keep them and add a milestone key to PLAN.md. Cheap, but the code
          still describes itself in plan terms.
ASK:      Rewrite now, or keep the labels until the next server pass?
```

```
FINDING:  Comments still describe the Rust server the TS server replaced
PATTERN:  no-home
WHERE:    18 comments, e.g. apps/server/src/http/cors.ts:1 ("the port of the
          Rust server's tower-http CorsLayer"), apps/server/src/chats/
          thread-state.ts:4 ("Frame bytes match serde_json::to_value"),
          apps/server/src/harness/approvals.ts:21,548
COST:     The code's own description points at a design that no longer
          exists. The wire format is real; the Rust implementation is not.
OPTION A: Describe the contract directly ("frame fields are emitted in
          declaration order; shipped clients depend on it").
OPTION B: Leave them: they explain why the byte order is fixed.
ASK:      Is the Rust byte-order dependency still a live constraint?
```

```
FINDING:  Three tables no code reads
PATTERN:  seam (expired)
WHERE:    apps/server/migrations/0056_routine_schedule_starts.sql,
          and the routines/routine_runs tables (SRS-26 says "leftovers")
COST:     A reader must decide whether routines are live. They are not.
OPTION A: Add one migration that drops the three tables.
OPTION B: Keep them and mark the rows in SRS-26 as dropped in a later schema.
ASK:      Drop them in the next migration batch?
```

```
FINDING:  The thread importer is a one-shot cutover tool living in the server
PATTERN:  boundary mismatch
WHERE:    apps/server/src/importer/{cli,durable,importer}.ts
COST:     It is a second way to write the durable tables, reachable from the
          server's own build and test tree.
OPTION A: Move it to scripts/ as a standalone entry point.
OPTION B: Keep it; it is already excluded from the request path.
ASK:      Is the cutover still expected to run again?
```

```
FINDING:  Two HTTP client designs in the desktop
PATTERN:  duplicate
WHERE:    apps/desktop/src/lib/api/*.ts (raw fetch, null on failure)
          apps/desktop/src/views/settings/admin-api.ts (throws ApiError)
COST:     Two error contracts for one server. A caller must know which one it
          is talking to before it can handle a failure.
OPTION A: Keep both, and say so in one line at the top of each: reads return
          null, admin writes throw.
OPTION B: Move admin-api onto a shared fetch wrapper and one error type.
ASK:      Does the settings UI rely on typed ApiError codes?
```

## Model limits

`translation_gaps` is 30. Most are `db -> ui` pairs with no declared mapper:
the client reads server JSON and types it with `as`. That is a real gap, not a
modelling mistake. It falls when a client mapper is written.

`unmapped_files` is 215 of 531. The model covers the nouns the product talks
about; it does not yet cover the harness internals, the sandbox runner, the
integration vendors or most views. That number is the reading backlog.

`shared_canonical` is declared for three files that hold many concepts:
`crates/protocol/src/api.rs`, `apps/server/src/platform/store/identity.ts`,
`apps/server/src/agents/store.ts`. Each is a boundary mismatch worth a split
when the file next changes.

---

# Sweep — every file read (2026-10-25, six lanes)

Six read-only agents read the 207 files the first pass left unmapped. The
model grew from 63 to 94 concepts and every source file is now either mapped
(299) or excused with a fixed reason (92). `unmapped_files` is 0.

| Lane | Files | Model added | Findings |
| --- | --- | --- | --- |
| `srv-platform` | 27 | 13 concepts, 26 attaches | 6 mechanical, 11 design |
| `srv-domain` | 29 | 13 concepts, 36 attaches | 6 mechanical, 5 design |
| `srv-runtime` | 39 | 7 concepts, 19 attaches | 4 mechanical, 6 design |
| `ui-thread` | 40 | 5 concepts, 42 attaches | 4 mechanical, 12 design |
| `ui-rest` | 46 | 2 concepts, 30 attaches | 5 mechanical, 8 design |
| `engine` | 26 | 1 concept, 11 attaches | 4 mechanical, 6 design |

Full finding blocks are in `lanes/<lane>.report.md`. Counts: 29 mechanical,
48 design.

## Cross-lane result

Eight concept ids were defined in two or three fragments at once (`machine`,
`approval`, `skill`, `agent`, `project`, `session`, `thread-event`, `chat`).
The check could not see it. They are now one record each in
`models/core-nouns.json`, and `check.py` fails when one id appears in two
fragments.

`session` was two concepts under one word and is now `engine-session` (the
cloud token the engine holds) and `login-session` (the server's login row).

## Highest-cost design findings

Rule violations (the repo's own `AGENTS.md` or `SRS` says otherwise):

- **Machine presence has two paths** — a direct push and a one-second poll
  (`ui-rest`). `AGENTS.md` says the server pushes status and clients never
  poll.
- **A project-bound chat changes the visible tab with no URL change**
  (`ui-thread`). `AGENTS.md` says every reachable surface has a fixed URL.
- **The admin save path skips the bundle-hash check** the turn path enforces
  (`srv-platform`). The manifest is approved by content on one path only.

Dead or broken wiring:

- **Agent delegation artifacts are typed and routed, but migration 0088
  dropped their table** (`srv-domain`).
- **The worker wire form cannot carry `agentsMd`, but the worker passes it**
  (`srv-runtime`).
- **`llm_calls` names a table that no code creates or writes** (`srv-platform`).

Second designs with live callers:

- **Two exec-policy engines**: the Rust crate has no importer, the TS one runs
  (`engine`).
- **Two dispatch paths**: worker-mode machine dispatch beside the hub
  (`srv-runtime`).
- **Two cursor designs** mirror the durable log into platform tables
  (`srv-domain`).
- **Two HTTP clients for the same skills endpoints** (`ui-rest`).
- **Four MIME tables with four answers** (`srv-domain`).
- **Five builders for the agent workspace path**, three `path.resolve` and
  two `path.join` (`srv-domain`).
- **Every vendor's base URL resolved twice, and the GitLab pair disagrees**
  (`srv-platform`).

One word, several meanings:

- `session`: chat, login row, engine token.
- `workspace`: sandbox target, prompt-file set, per-turn write journal,
  signed-in server, agent folder.
- `thread`: a chat and an `agent_threads` row, both ids on one wire node.
- `call` / `span`: an LLM span and every span.
- `integration` / `connector` / `plugin`: one concept, three words; the plugin
  executor kind is called `rust` although the code is TypeScript.
- `tab`: `SidebarTab` and `ChatRoute.tab` have different value sets.

## Floor note

`loc` rose 122389 -> 122428 (+39) during this work. The rise is not from the
model: another session edited `crates/app-server/src/machine_link.rs` in the
same checkout. `floor.json` was updated once, at merge, and records the tree
as it is.

## Workspace snapshot (2026-10-25, commit 0539451f)

`apps/server/src/hub/workspace.ts` held the sidebar push snapshot and had no
model entry. It is now `workspace-snapshot` in `srv-domain.json`: canonical
`workspace.ts`, role `wire`, aliases `sidebar-snapshot` and `workspace-push`.
The concept is one user's whole sidebar state (active chats, archived chats,
projects, machine registry) built for the member socket.

`unmapped_files` returned to 0. `files` rose 531 -> 532 and `loc` 122428 ->
122682. The file counter is this one file. The line counter is the net of the
whole commit across 29 files; every other file in it was already modelled.
The floor records the tree as it is, and no counter is excused.

## Gate work (2026-10-26, commits 9b466d16..61e90f78)

`loc` rose 122682 -> 122733 (+51) when the three gate branches merged. No new
source file appeared (`files` stays 532). The lines are the merged work: the
`skills_home()` consolidation in `fs_bridge.rs` and `machine_link.rs`, the
ClickHouse credential helpers in the test harness, and the poll helpers that
replace fixed sleeps in the server tests. `floor.json` was updated once, after
the merge, and records the tree as it is.

---

# Round 1 fixes (2026-10-25, six fixer lanes in worktrees)

Six fixers worked in separate worktrees, each on its own branch from
`fix/coherence`. They fixed only the findings with one obvious answer and
left every design choice to a human.

| Lane | Fixed | Skipped |
| --- | --- | --- |
| `srv-platform` | 3 | 14 |
| `srv-domain` | 2 | 9 |
| `srv-runtime` | 3 | 7 |
| `ui-thread` | 4 | 12 |
| `ui-rest` | 2 | 11 |
| `engine` | 2 | 8 |

Fixed:

- one approval-policy prompt constant, one v2 secret-name rule, one 422 body
  builder (`srv-platform`);
- one ThreadState encoder; two uncalled hub methods deleted (`srv-domain`);
- one BIGINT parser; dead inbox mode test; `models` removed from the codemode
  lint (`srv-runtime`);
- dangling comment fragments; approval labels derived from one table; Tauri
  check imported from `lib/session`; `resolve-project-dir` now sorts by
  activity as its comment claims (`ui-thread`);
- one "N things" helper; one agent export body (`ui-rest`);
- the stdio envelope built from `Request`; three stale `tests/agent_rpc.rs`
  comments fixed (`engine`).

Left open by the fixers, worth a second look:

- The Tauri check still has three more copies:
  `views/thread/hooks/{use-composer,use-member-socket,use-outgoing}.ts`.
- `count` now serves the skills panel from a file named for agents
  (`views/agents/activity-format.ts`). The home is wrong for the reach.
- `crates/app-server` has one pre-existing test failure on `develop`:
  `machine_link::tests::remote_context_and_prefetch_roundtrip_on_mock_hub_socket`.
  It is not from this round.

Verification on the merged round branch: server tsc, desktop tsc, desktop
vitest 513 passed, `npm run coherence` clean, `cargo test` 88 passed with the
one pre-existing failure above.

## Round 2 — the design findings, decided and applied

Round 1 fixed the mechanical findings and left 61 that needed a choice. Every
one of them now has a decision in `decisions.md`. Six lanes applied them:
38 in the backend, 26 in the client.

Policy that shaped the round:

- wire values, route paths, database columns and migrations do not change;
- dead code goes when the tree has no caller;
- where both options would cross the wire, the code keeps a dated
  `coherence:seam` with an owner instead of a rename;
- one concept, one home — a copy that exists only because a module was split
  is deleted.

Landed:

- `engine` — the vendored `codex-execpolicy` and `codex-utils-absolute-path`
  crates are gone (3965 LOC); the TS gate is the one exec-policy engine.
  `jsonrpc_loop::Session` is `EngineState`, so the three meanings of "session"
  are three names. Four test-only env vars and three link-test helpers are
  recorded seams, not copies.
- `srv-platform` — `integration-catalog.ts` is the one declaration list for
  integration kinds; `connectors.ts` is gone. `domain/tool-class.ts` owns the
  risk vocabulary. The vendor base URL and the Google token mint each have one
  resolver. `rust-json.ts` splits the Rust JSON renderer out of the SSE frame
  decoder.
- `srv-domain` — `agentWorkspaceDir` is the one workspace path builder;
  `platform/domain/mime.ts` the one MIME table. Presence has one source: the
  machine store, pushed. Delegation artifacts and the presence poll are gone.
- `srv-runtime` — the worker wire carries `agentsMd`; the coding-tool sentence
  comes from `CODING_TOOL_NAMES`; `HANDLE_METHODS` is checked against the typed
  sandbox proxy by a test. `int_` tolerance and the IPC dispatch proxy are
  seams with dates.
- `ui-thread` — the rail entry is a projection of `ChatRoute`, not stored
  state. A project chat opens on its project URL. Settings paths live in
  `lib/api/settings.ts`; the usage filter is in the route model. Presence reads
  the machine store. Three Tauri checks became one import.
- `ui-rest` — `/chats/<id>` replaces `/sessions/<id>` (the old URL rewrites);
  the workspace switcher is a server switcher. `/runs/<id>` is `run.id` only,
  trace-only turns get `/traces/<id>`. The activity filters live in
  `AgentsRoute`. Skill versions have one parser; the folder picker one body.
- both — the instruction chain is one rule with two readers: AGENTS.md with
  its override, plus MEMORY.md, 32 KiB, on the client and on the server.

Floor: files 526, loc 119305 (119147 before `develop` merged; the
gate work in `develop` adds 158 lines of test and skill-home code). The 11 seams are the round's declared
replacements for renames that would have crossed the wire; each has an owner
and a date. They are the one counter that rose, and they rose because this
round chose a dated seam over a break.

Verification: server tsc, desktop tsc, desktop vitest 514 passed, server
vitest on the touched suites, `cargo test` 88 passed with the one pre-existing
`machine_link` failure, `check.py` clean.
