# Milestone: projects + WSL — implementation plan

Date: 2026-09-17. Spec: `docs/specs/2026-09-17-projects-wsl-design.md`.
Branch: `projects-wsl` (worktrees per lane). Integration + deploy by the
orchestrator after lanes merge.

Integration contract frozen in the spec §1–§4; lanes may start in parallel
where their inputs are listed as frozen shapes below.

## Lane A — server + protocol (branch `projects-wsl-server`)

1. Migration 0047: `projects` table (spec §1).
2. Migration 0048: wipe — drop chats/thread_events/chat_reads/attachments +
   every chat-keyed table found by `grep -rn chat_id crates/server/migrations/`;
   recreate `chats` fresh (spec §1 column list, `project_id` instead of
   `project_dir`); clear `tool_dispatch:`/`approval:` kv rows.
3. Store: `projects()` CRUD (owner-scoped + admin bypass, unique
   (user_id, name)); chat create/update accept `project_id`; project delete
   nulls referencing chats in one transaction.
4. HTTP: projects endpoints (spec §2); remove `POST /chats/{id}/dir` +
   `set_project_dir`; gateway request takes `project_id` (protocol api.rs),
   drop `project_dir`.
5. ChatRunner: journaled project lookup (chat→project→folder, mirror the
   approval-join pattern); system prompt names the workspace (WSL-parsed
   sentence, spec §3); `ToolDispatch` gains `workdir: Option<String>`
   (protocol ws.rs) filled from the project folder; ThreadSummary/ThreadState
   gain `project_id`/`project_name`/`project_machine_label` for the sidebar.
6. Regenerate ts bindings (`crates/protocol/ts`).
7. Tests: projects CRUD roundtrip + name 409 + delete-unlinks; wipe migration
   via the migration suite; dispatch-carries-workdir with the scripted
   executor harness; prompt-shape unit test (WSL vs plain path).
   Gate: full `GUILD_TEST_PG_URL` suite green.

## Lane B — guild-core WSL routing (branch `projects-wsl-core`)

1. `tools/workspace.rs`: `WorkspaceKind` + `classify` (spec §4), accepts
   `\\wsl.localhost\` and `\\wsl$\`, inner-path conversion.
2. `shell.rs`: WSL branch — `wsl.exe -d <d> --cd <inner> --exec bash -lc
   <cmd>`, CREATE_NO_WINDOW kept, default user only; Unix/WindowsNative
   branches unchanged.
3. `fs.rs`: WSL read via `base64 <path>`, write via stdin-piped
   `sh -c 'cat > <quoted-path>'`, edit = read+apply+write; scoped-path
   checks unchanged and applied to the inner path.
4. Tests (host-runnable): classify matrix; WSL command construction shape
   (assert the spawned argv through an injected runner seam or by factoring
   command building into a pure fn); fs transport quoting (path with spaces,
   quote chars); resolve_scoped escape rejection on inner paths.
   Gate: guild-core + protocol suites green on Linux.

## Lane C — desktop (branch `projects-wsl-desktop`, starts after A's protocol
shapes land on the milestone branch)

1. App process: `list_wsl_distros` + `list_dir` commands (spec §5), invoke
   registration, transport wrappers; delete `set_chat_dir`, `GuildState.dirs`
   (executor reads `workdir` from the dispatch frame; frame struct updated).
2. Webview: sidebar Projects/Recents restructure (URL-driven project
   section); "Choose project" chip + picker dialog (search, recents, new);
   create-project dialog with folder sources (native dialog | distro rows →
   path specifier with dotfiles, `~` field, Enter semantics, state dots);
   project deep-link route.
3. Delete per-chat folder code: `pickProjectDir`, localStorage keys, chip
   legacy render, blind fallback picker.
4. Gateway send: `project_id` replaces `project_dir` (transport.ts).
5. Tests: vitest pure — sidebar grouping derivation, picker state machine,
   chip label; `tsc` + `vite` clean.

## Integration (orchestrator)

1. Merge A → B → C into `projects-wsl` in dependency order; resolve
   conflicts (protocol shapes are the likely site).
2. Full server suite + desktop vitest + tsc/vite on the integrated branch.
3. Deploy: compose build+up; **wipe Restate container state** after the new
   server is up (spec §1); health + projects endpoint smoke via curl.
4. Release desktop clients (`scripts/release-clients.sh`); manual exe copy
   to devbox per deploy-nuances.
5. Live verification on devbox: create project on `archlinux` distro folder,
   execute + read/write via the GUI, approval card shows the raw command.
6. PLAN.md entry + journal notes; review loop (security + correctness lanes)
   on the integrated diff before calling the milestone done.

## Execution notes

- Workers: `pi` only (currently selected model). Layout: orchestrator left
  column; lanes split to the right (3 lanes → 1 column split into 3).
- Long builds/tests run detached per `~/workspace/hanging-commands.md`
  (systemd-run with explicit `-p WorkingDirectory=`).
- Comments describe present-tense behavior; PLAN.md carries the story.
