# Projects + WSL — design

Date: 2026-09-17. Status: approved in interview (maintainer), see PLAN.md for
the decision trail. Supersedes the per-chat folder mechanism entirely.

## Goals

1. Codex-style **project model**: a project is a named folder bound to a
   machine; threads attach to projects; the sidebar groups threads by
   project.
2. **WSL support**: a WSL distro is a folder source on its Windows machine;
   shell and file tools execute inside the distro.
3. **Clean slate**: all thread-related data is wiped (DB + Restate state);
   the product starts from an empty sidebar with the new model.

## Non-goals

- Remote-machine folder browsing (follow-up; the folder-source shape in the
  create dialog is built so a remote source slots in later).
- Multi-folder projects (one folder per project; extendable later).
- Skills discovery through wsl.exe (stays on the 9P share; noted follow-up).
- A folder/app-opening tool (dropped — no chat-turn need).

## 1. Data model (server)

New table `projects` (migration 0047):

```
projects (
  id          UUID PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES users,
  org_id      UUID NOT NULL REFERENCES orgs,
  name        TEXT NOT NULL,
  folder      TEXT NOT NULL,        -- Windows path, UNC for WSL
  machine_id  TEXT NOT NULL,        -- machine the folder lives on (no FK, like chats.machine_id)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
)
```

`chats` gains `project_id UUID NULL` (no FK cascade — SET NULL on project
delete is handled in the delete endpoint, keep the column plain like
`machine_id`). Owner-scoped access with admin bypass, same shape as chats.

### Wipe (migration 0048)

Thread-related data is dropped, not migrated:

- DROP `chats`, `thread_events`, `chat_reads`, `attachments`, and any
  per-chat usage/spend rows keyed by chat id (implementer: enumerate every
  table with a `chat_id` column; drop the chat-scoped ones).
- Recreate `chats` fresh with all current columns minus `project_dir`
  (0045's column never returns): `id, org_id, user_id, title, created_at,
  machine_id, machine_label, generating, approval, project_id`.
- Clear kv rows with the `tool_dispatch:` / `approval:` prefixes.
- **Restate storage is wiped at deploy time** (its container holds state in
  the container layer; `docker compose rm -f restate` after the new server
  is up) — otherwise old journals replay against a DB without their chats.

Kept: users, teams, orgs, machines registry, integrations, registry, skills,
org settings, account-level approval policies.

## 2. API (server)

- `GET /api/v1/projects` — owner's projects (admin: all org projects), each
  row `{id, name, folder, machine_id, machine_label, created_at}`.
- `POST /api/v1/projects` `{name, folder, machine_id}` → row; 409 on
  duplicate name.
- `PUT /api/v1/projects/{id}` `{name?, folder?, machine_id?}`.
- `DELETE /api/v1/projects/{id}` — refuses while chats reference it? No:
  sets `chats.project_id = NULL` in one transaction (chat survives,
  folderless).
- Chat create/PUT gains optional `project_id`. (Amendment 2026-09-19, per
  unification spec §7: the per-chat machine override endpoint
  (`POST /api/v1/chats/{id}/machine`) is retired, and chat-create's
  `machine_id` auto-bind with it — machine comes from the project only.)
- `POST /api/v1/chats/{id}/dir` **removed**; `chats.project_dir` column is
  gone.

## 3. Folder flow (replaces the volatile chat→dir map)

- `ChatCompletionRequest`: `project_dir` replaced by `project_id:
  Option<Uuid>`.
- `ChatRunner` resolves `project_id → projects.folder` (journaled read like
  the approval join) and:
  - names the workspace in the system prompt — for a WSL folder, parsed:
    "The workspace is `<linux path>` inside WSL distro `<distro>` on machine
    `<label>`; shell commands run inside that distro." Plain Windows folder
    keeps today's sentence shape.
  - puts the folder into **`WsServerMsg::ToolDispatch`** as a new
    `workdir: Option<String>` field. The executor uses it directly; no
    webview push, nothing volatile. `workdir: None` → same
    "no workspace" error result as today.
- Model-history/prompt behavior otherwise unchanged.

## 4. WSL routing (guild-core)

Workspace kind is derived from the tool `workdir` path — no machine-OS
lookup needed:

```
enum WorkspaceKind { Unix, WindowsNative, Wsl { distro: String } }
fn classify(workdir: &Path) -> WorkspaceKind
```

- `\\wsl.localhost\<distro>\…` (and legacy `\\wsl$\<distro>\…`) →
  `Wsl { distro }` with the inner Linux path (`\` → `/`).
- One helper module in `guild-core/src/tools/` used by shell + fs tools.

**Shell tool** (`execute`), WSL case:

```
wsl.exe -d <distro> --cd <inner-path> --exec bash -lc <cmd>
```

`--exec` passes argv directly (no shell around the wrapper); `-lc` loads the
profile so the distro's PATH (nvm/cargo/…) is present; default user only —
tools never pass `-u`. `CREATE_NO_WINDOW` stays. Distro auto-start is
accepted (first call pays boot); a missing distro fails the tool with a
clear message.

**File tools** (`read_file`/`write_file`/`edit_file`), WSL case — routed
through wsl.exe, never the 9P share:

- read: `wsl.exe -d <d> --exec base64 <abs-path>` → decode in Rust.
- write: stdin-piped bytes to `wsl.exe -d <d> --exec sh -c 'cat > <quoted
  path>'` (path is `resolve_scoped`-checked; single-quote escaped).
- edit: read → existing in-Rust diff apply → write.
- Writes land with the distro's default umask (no mode preservation) —
  accepted.

**Policy**: the exec-policy gate classifies what the model writes, which is
the raw command; the wsl.exe wrapper is added at spawn time inside
guild-core, so the gate needs **no unwrap logic**. Model-written
`wsl …` segments match no allow rule → `Prompt` (default), one click.
An explicit base-rule entry documenting `wsl` → Prompt keeps the intent
visible.

## 5. Desktop app

### App process (Rust, Tauri commands)

- `list_wsl_distros() -> Vec<Distro>`: `wsl.exe --list --verbose` with
  `WSL_UTF8=1` (clean UTF-8), parsed into `{name, running}`; hide
  `docker-desktop*`; distro pretty name (`/etc/os-release` PRETTY_NAME via
  one `wsl -d <d> --exec cat`) fetched lazily and cached per boot.
  Non-Windows or wsl-absent → empty list.
- `list_dir(root: String) -> Vec<Entry>`: std fs `read_dir` over the given
  path (works for `\\wsl.localhost\…`); used by the path specifier.
- Registered through the existing invoke-handler + `transport.ts` wrapper
  pattern.

### Webview

- Sidebar becomes Codex-shaped: **Projects** section (collapsible; each
  project with machine badge), threads listed under the selected project, a
  **Recents** view for projectless/browsing, "New chat" unchanged. Project
  rows deep-link (`/project/<id>` URL-driven like settings sub-pages).
- Composer chip: **"Choose project"** (replaces "Run in folder…").
  Projectless by default. The picker dialog: search, recent projects, "New
  project". Picking sets the chat's project (persisted `chats.project_id`,
  sent as `project_id` on the gateway request).
- **Create project dialog**: name + "Add a folder on \<machine\>" —
  this milestone: local machine only. Sources:
  - "This computer" → native OS folder dialog (as today).
  - One row per distro: `node2 (Ubuntu)`, `archlinux (Arch Linux)` with
    running/gray dot → **path specifier**: unfiltered directory listing
    (dotfiles included), `~`-expanded absolute path field, Enter jumps into
    a typed path or descends the highlighted row, breadcrumb up-navigation,
    Confirm. Browsing reads via `list_dir` on `\\wsl.localhost\<d>\…`.
  - Other machines: listed but disabled ("browse coming later").
- The mid-turn blind folder picker, `set_chat_dir`, `pushChatDir`,
  localStorage `guild.dir:*`, and the app-process `GuildState.dirs` map are
  **deleted**.
- Approval cards, tool frames, thread feed unchanged.

## 6. Testing

- guild-core: `classify` parsing (UNC/`wsl$`/plain/POSIX), WSL file-tool
  transport shape (command construction; unix-runnable with a stub), scoped
  path rejection preserved. Windows spawn behavior verified live on devbox.
- server: projects CRUD + name conflict + delete-unlinks; wipe migration
  covered by the migration suite (`migrations.rs` runs every migration);
  dispatch carries `workdir` (gateway_tools.rs style with a scripted
  executor).
- desktop: vitest pure tests — sidebar grouping, picker state machine
  (sources → browse → confirm), chip label derivation.
- Live verification on devbox: pick an archlinux folder, run + read/write
  through the GUI.

## 7. Deploy

Compose rebuild + restate state wipe (see §1) + desktop release
(`scripts/release-clients.sh`), devbox gets the manual exe copy per
`docs/deploy-nuances.md`. TS bindings regenerated from protocol changes
(`crates/protocol/ts` is generated — never hand-edited).
