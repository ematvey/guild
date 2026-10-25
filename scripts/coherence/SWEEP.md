# Coherence sweep — plan and record

Everything about the decoherence work on Guild lives here. `findings.md` holds
the findings; this file holds the plan, the state, and the lane assignments.

## 1. Where this started

The decoherence method comes from `~/acme/acme/.agents/skills/`.
It has two halves: read the code and write a domain model, then compare the
model against the tree. The model is a committed file, not a memory.

Installed in this repo:

| Path | What it is |
| --- | --- |
| `scripts/coherence/check.py` | The gate: counters, seams, model consistency, coverage. Ported from Go/Acme to Rust+TS/Guild. |
| `scripts/coherence/floor.json` | The ratchet. Counters may go down, never up. |
| `scripts/coherence/models/*.json` | The domain model, one fragment per area. |
| `scripts/coherence/findings.md` | What was fixed and what needs a human decision. |
| `scripts/coherence/README.md` | How the tool works and what it enforces. |
| `.agents/skills/decoherence-fix/` | Load to clean up. |
| `.agents/skills/decoherence-prevent/` | Load before a change. |
| `package.json` scripts | `npm run coherence`, `npm run coherence:report`. |

## 2. State

After the first pass (headers only):

```
files            531   loc 122428   seams 0   shims 19
duplicate_files    0   translation_gaps 30   unmodeled_types 0
unmapped_files   207   of 399 non-test files
```

After the six-lane sweep (every file read):

```
files            531   loc 122428   seams 0   shims 19
duplicate_files    0   translation_gaps 19   unmodeled_types 0
unmapped_files     0   of 391 non-test files (299 mapped, 92 excused)
```

Model: 94 concepts, 259 representations, 86 translations, in eleven fragments
(`core-nouns`, `protocol`, `engine`, `server-core`, `desktop`, `ui-kit`, and
one per sweep lane).

The first pass read the docs and the module headers. The sweep read the
implementation bodies. Findings from both are in `findings.md`; the full
blocks are in `lanes/<lane>.report.md`.

## 3. What the first pass fixed (mechanical)

1. Four byte-size formatters → `apps/desktop/src/lib/format.ts`.
2. Two homes for the session token → `lib/session.ts` only.
3. Raw `localStorage` keys in `App.tsx` → `SERVER_URL_KEY`, `setToken`.
4. `initialsOf` vs `initials` (one word, two rules) → `avatarChip`.
5. Dead `InMemoryHub` in `apps/server/src/hub/index.ts` → deleted.
6. Dead files: `packages/ui/src/components/{caret,scroll-area,separator}.tsx`,
   `apps/desktop/src/views/projects/ProjectPickerDialog.tsx` → deleted, with
   the two Radix dependencies they alone used.
7. Stale paths in comments (`lib/context.ts` ×3, `M3-REPORT.md`) → fixed.

## 4. What needs a human decision (design)

Full blocks are in `findings.md`. Summary:

| # | Finding | Pattern |
| --- | --- | --- |
| 1 | 17 deprecated route aliases with no owner and no delete date | seam |
| 2 | 47 comments still name build milestones M3–M8 | no-home |
| 3 | 18 comments describe the removed Rust server | no-home |
| 4 | `routines`, `routine_runs`, `routine_schedule_starts` tables unread | seam (expired) |
| 5 | One-shot thread importer lives in the server source tree | boundary |
| 6 | Two HTTP client error contracts in the desktop | duplicate |
| 7 | `crates/codex-execpolicy` + `codex-utils-absolute-path`: 3965 LOC, no importer | duplicate |
| 8 | `crates/server/data-test/` — 1.1 MB untracked, crate does not exist | seam (expired) |

## 5. The sweep (done)

Six read-only lanes. Each reads every file in its list, extends the model,
and writes a report. The lists are in `scripts/coherence/lanes/<lane>.md`.

| Lane | Files | Area |
| --- | --- | --- |
| `srv-platform` | 27 | stores, domain event helpers, HTTP route modules |
| `srv-domain` | 29 | agents, chat bridge and projection, member-socket hub |
| `srv-runtime` | 39 | harness, sandbox runner, durable storage, worker, importer |
| `ui-thread` | 40 | thread view and hooks, sidebar, projects, settings |
| `ui-rest` | 46 | agents and skills views, shared views, lib, Tauri shell |
| `engine` | 26 | vendored codex crates, app-server, protocol, guild-core |

Contract for every lane:

- read-only on source; write only `models/<lane>.json` and
  `lanes/<lane>.report.md`;
- extend the model, never duplicate another lane's concept — use `attaches`;
- every finding names both sides with file and line, and asks one question;
- no worktrees. The checkout already carries another session's uncommitted
  `crates/app-server/src/machine_link.rs`; copying the tree into worktrees
  would copy half-finished work and make the model describe the wrong tree.

Why no worktree per agent, against the default pattern in
`~/workspace/agent-orchestration.md`: these agents do not write code and do
not run builds. Isolation would add nothing, and it would give each agent a
tree that differs from the one under inspection.

## 6. Merge protocol (orchestrator) — done

All six reports landed. The eight concept ids that appeared in two or three
fragments were merged into `models/core-nouns.json`, and `check.py` now fails
when one id appears in two fragments. `session` was split into
`engine-session` and `login-session`. `floor.json` was updated once, at the
end. All panes were closed; `herdr agent list` shows none of them.

The protocol, for the record:

1. Wait for all six reports. Read each verdict, not the pane state.
2. Merge the six fragments into `models/` as they are. Fix only cross-lane
   collisions: an alias that means two things in two lanes is a real finding,
   so record it in `findings.md` and keep the better name.
3. Run `python3 scripts/coherence/check.py check`. Drive
   `unmapped_files` to 0, or to the honest residue with a `no_concept` reason.
4. Run `python3 scripts/coherence/check.py update` once, at the end, and
   commit `floor.json` with the model in the same change.
5. Close every pane. `herdr agent list` must show nothing you started.
6. Verify: `npm run coherence`, desktop `tsc --noEmit` + `vitest run`,
   server `tsc --noEmit`, `cargo test --workspace`.

## 7. Open questions for the user

1. Which desktop version is the oldest one you still support? That sets the
   delete date for the 17 route aliases.
2. Rewrite the M3–M8 comments now, or keep the labels until the next server
   pass?
3. Is the Rust byte-order dependency still a live constraint, or can the
   comments describe the contract directly?
4. Drop the three unread tables in the next migration batch?
5. Is a Rust-side exec-policy evaluation still planned? That decides the two
   vendored crates.
6. Does the settings UI rely on typed `ApiError` codes? That decides whether
   the desktop keeps two HTTP client contracts.
