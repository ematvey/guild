# Decisions for round 2

The sweep left 61 findings open because each needs a choice. The user asked to
finish all of them. This file records the choice for each one, so a fixer does
not have to guess and a reader can see why.

## Policy

1. Wire values, route paths, database columns and migrations do not change.
   A shipped client may depend on them.
2. Delete dead code when nothing in this tree calls it. Git keeps the history.
3. Where both options need a rename that crosses the wire or the database,
   mark a `coherence:seam` with an owner and a date instead of renaming.
4. User-visible text changes only when the current text is wrong ("1 tools")
   or when the finding is a rule violation in `AGENTS.md`.
5. One concept, one home. If a second copy exists only because a module was
   split, the second copy is deleted.
6. No new dependency. No new top-level module unless the finding names it.

Seam default for this round: `owner=@ematvey until=2027-01-31`.

## engine

| Finding | Decision |
| --- | --- |
| Two exec-policy engines | Delete `crates/codex-execpolicy` and `crates/codex-utils-absolute-path`, their workspace members, and the version note in `docs/deploy-nuances.md`. Nothing imports them; the TS gate is the live one. |
| Three permission vocabularies | Keep `Approval` as the engine's enum and `ExecPolicyDecision` as the server's. Fix the TS split: the parser emits `deny`, never `forbidden`. Record both concepts in the model. No rename across the wire. |
| `session` names three things | Rename `jsonrpc_loop::Session` to `EngineState`. Keep `StoredSession` and `AuthState`. In-tree rename only. |
| Four test-only env vars | Mark each with a seam and read the socket override once above the cfg split. |
| Three loopback-helper copies | One `crates/app-server/tests/common/mod.rs`; the three tests import it; the dead `tests/agent_rpc.rs` pointer goes. |
| Dead `sandbox_migration.rs` | Delete the module and its test. No caller. |
| Three link tests bypass `transition` | Build the fixtures with `AuthState::default()` plus `transition`. |
| Eight ids in several fragments | Done in round 0 (`core-nouns.json`, duplicate-id check). |

## srv-platform

| Finding | Decision |
| --- | --- |
| org-KV key strings declared twice | One constant set in `platform/store/org_kv.ts`; writer and readers import it. |
| `PluginSecretSource` twice | Keep `plugins.ts`; `execute.ts` imports it. |
| Vendor base URLs resolved twice, GitLab disagrees | One resolver per vendor in `integrations/vendors/shared.ts`; the runtime path is canonical. |
| Google token mint twice | Keep the runtime mint; delete the save-probe copy. |
| Integration kinds catalogued three times | `platform/integration-catalog.ts` is the single source; the other two derive from it. |
| Admin save skips the bundle-hash check | Admin save uses the same check as the turn path. Security fix. |
| `llm_calls` table unread | No code change. The table stays in migrations; note it in `SRS-26`. |
| `session` three meanings | Model only (done). No code rename here. |
| `integration` / `connector` / `plugin` | Keep `integration` as the noun. Rename in-tree identifiers only; stored values stay. |
| Tool risk class has no home | One module `platform/domain/tool-class.ts`; both callers import it. |
| `sse.ts` holds two designs | Split the file: frame decoder and text renderer. |
| Two execute entry points | Keep the public one; the other calls it, or is deleted if test-only. |
| Skill-read sink repeats usage sink | One attribution helper; both sinks call it. |
| `plugins.ts` holds two concepts | Split the call envelope from the tool-class policy. |

## srv-domain

| Finding | Decision |
| --- | --- |
| Agent workspace path built five times | `agentWorkspaceDir` in `workspace-config.ts` is the home and takes the root as an argument; the other four call it. |
| Terminal assistant text, two scans | One exported helper over event rows; `delivery.ts` queries rows and calls it. |
| Two path rules for symlinks | Keep the stricter rule in `files.ts`, export one resolver, and use it in `send-file.ts`. A tool may not read through a symlink. |
| Delegation artifacts after the dropped table | Delete the types, `createArtifact`, `listArtifacts`, the route, and the desktop fields. Nothing in the tree calls them; the live home is `attachments`. |
| MIME classification in four tables | One module `platform/domain/mime.ts`; all four import it. The widest list wins, since it only decides inlining. |
| `thread` = chat and `agent_threads` row | Model split only (`chat`, `agent-thread`). Rename in-tree identifiers where the file already says `chat`; no wire change. |
| Machine presence pushed and polled | Delete the poll; the push is the source. |
| Two cursor designs | Keep both; mark a seam with the reason "durable log and platform tables retire at different times". |
| `workspace` three meanings | Split the names in-tree: `sandboxWorkspace`, `promptFiles`, `writeJournal`. No wire change. |

## srv-runtime

| Finding | Decision |
| --- | --- |
| Worker wire cannot carry `agentsMd` | Make `SubmitTurnWireInput` carry it. One shape, the type tells the truth. |
| `int_` legacy branches | Seam markers, not deletion. Reason: shipped clients may still send the prefix. |
| Coding-tool set named three times | `CODING_TOOL_NAMES` is the source; the prompt sentence is built from it. `list` and `web_search` are agent tools, not coding tools. |
| Durable conversation has no org | Delete the unused `orgId` parameter; state in the concept definition that the chat row owns the tenant. |
| Sandbox handle list in two copies | Add the test that walks `HANDLE_METHODS` and asserts the proxy has each method. |
| Three chat-to-conversation accessors | Add a reverse map so the read is O(1); document which accessor may create. |
| Worker dispatch proxy | Seam marker. Reason: IPC dispatch until workers hold a hub connection. |

## ui-thread

| Finding | Decision |
| --- | --- |
| Approval mode, two vocabularies | Keep both enums. One mapping function; "server" and "default" are the same value and get one name in code. No label change. |
| `SidebarTab` vs `ChatRoute.tab` | Derive the rail entry from the route; delete `SidebarTab`. |
| Project chat changes tab without a URL change | The URL is truth: a project chat opens on the project route with its tab in the path. |
| Two folder browsers | Extract the shared body; each keeps its transport and path adapter. UNC stays. |
| Two folder equality rules | One lookup with a path-key function that names the Windows rule. |
| Settings views call endpoint paths directly | Move every settings call behind a `lib/api` module. |
| Default assistant prompt twice | The read response carries the effective default; the client stops hardcoding it. This touches the server read endpoint, which is allowed for this lane. |
| Machine presence, two sources | The machines store is the only presence source; the chat row stops carrying `machine_online`. |
| Three settings caches | One clear registry that every cache registers with. |
| Each section parses the detail string | One codec interface per section; the string stays the wire shape. |
| Usage filters outside the route model | Extend `ChatRoute` with the usage query state. |
| Full-page tab rule in two modules | `tabPaneLayout` returns the page kind for every full-page tab. |

## ui-rest

| Finding | Decision |
| --- | --- |
| `initials` three rules | `avatarChip` in `lib/format.ts`; `agent-ui.initials` becomes `nameInitials`; the fourth inline copy goes. |
| Relative time past and future | The future branch lives in `lib/relative-time.ts`; `AgentRoutines` imports it. |
| `session` = chat, login, token | The activity surface says "chat": `/chats/<id>`, `SessionRow` becomes `ChatActivityRow`. Old `/sessions/<id>` links redirect. |
| `workspace` = server and folder | The switcher says "server": `ServerRow`, `/api servers`. The engine keeps `workspace` for the folder. |
| `/runs/<id>` takes two ids | `run.id` owns the route; a trace-only turn gets its own route. |
| `call` vs `span` | Labels only: the tab says "Model calls", tool rows stay spans. |
| Two instruction rules | One rule with two readers. The file set and budget are `AGENTS.md` (override beats plain) plus `MEMORY.md`, 32 KiB total, for both sides. The client keeps its reader because only it can see a machine-bound folder; the server keeps its reader for sandbox chats. The server's 8 KiB per file and 24 KiB total, and its `MEMORY.md`-only set, go. |
| Two HTTP clients for skills | One client: `lib/api/skills.ts` calls `skills-api.ts`. |
| `ChatMessage` two shapes | Both readers map into the protocol `Message` shape. |
| Agent export and delete dialog twice | One `AgentActions` block; the settings tab renders it. |
| Agents surface has two URL models | The activity query moves into `AgentsRoute`. |
| Skill version two shapes | One version module: one parser, one formatter; the three helpers call it. |

## Order

Backend first (engine, srv-platform, srv-domain, srv-runtime), then the client
(ui-thread, ui-rest), because the client changes read the server shapes.
