# Skills design — modeled after Codex

2026-09-16. Verified against: pi docs (`docs/skills.md`), OpenAI Codex docs
(developers.openai.com/codex/skills) + codex-cli 0.154.0 binary strings, and
the Guild codebase.

> **Amendment 2026-09-19 — ownership moved to the client.** This spec's
> Rust-side implementation (app-server `skills.rs` / `agents_md.rs`, the
> `skills.list` / `skills.prepare_turn` daemon verbs, discovery wired into
> `agent.start`) was deleted by unification spec §4 phase 2: discovery,
> index assembly, and AGENTS.md chaining now live in TS
> (`apps/desktop/src/lib/context.ts`) over the allowlisted `fs.*` bridge.
> The behavioral contract below (frontmatter format, first-match-wins
> `/name`, index budget, scope precedence user-beats-project or as coded)
> survives as the TS module's contract and the additive
> `skills_index` / `agents_md` request fields; the server never owns the
> system prompt. Browser (no local files) stays global-less by nature;
> web parity comes from unification §4 phase 5, not from this spec's
> Rust plumbing.

## 0. Bottom line

Guild's skill plumbing exists but is dead: `app-server/src/skills.rs` has
discovery + index rendering, `jsonrpc_loop.rs` never calls it
(`system: None, // skills index lands in Task 7`), so the agent never sees
any skill. The registry side (publish → review → install into
`{project}/.guild/skills/<slug>`) is built and fine. What is missing is the
agent-facing half. This doc specifies it, following Codex's model.

## 1. Verified: how the reference agents do it

### Codex (authoritative model)

- **Format**: SKILL.md with `name` + `description` frontmatter
  (agentskills.io standard). Optional `agents/openai.yaml` for UI metadata,
  `policy.allow_implicit_invocation`, tool dependencies.
- **Locations** (scanned at startup, symlink-followed):
  - `REPO`: `.agents/skills` in every directory from cwd up to repo root
  - `USER`: `$HOME/.agents/skills`
  - `ADMIN`: `/etc/codex/skills`
  - `SYSTEM`: bundled by OpenAI (skill-creator, plan, …)
  - plus skills installed by `$skill-installer` into `$CODEX_HOME/skills`
    (default `~/.codex/skills`) and skills bundled in plugins
  - Same-name skills are NOT merged; both appear in selectors.
- **System-prompt index**: name + description + file path per skill. Budget:
  at most 2% of the context window, or 8,000 chars when the window is
  unknown. Codex shortens descriptions first; with a very large set it may
  omit skills and show a warning. Full SKILL.md is only loaded on use
  (progressive disclosure).
- **Invocation**: explicit (`$skill-name` in the prompt, `/skills` selector)
  or implicit (the model matches the task against descriptions).
- **Freshness**: `skills_watcher` watches dirs → `skills/changed` event;
  clients re-render. Docs still say "restart Codex if it doesn't appear".
- **Disable**: `[[skills.config]]` with `path` + `enabled = false` in
  config.toml — per-SKILL.md-path toggle, no delete needed.

### pi (this agent harness — same ideas, different locations)

- Loads from `~/.pi/agent/skills`, `~/.agents/skills`, project
  `.pi/skills` + `.agents/skills` (cwd→root), packages, settings array.
- Progressive disclosure; descriptions always in system prompt; full
  SKILL.md loaded by the model via read when relevant; `/skill:name` command
  to force it. Discovery conventions differ but the format is the same
  SKILL.md.

Key takeaway: both use the identical SKILL.md format; only directory
conventions differ. Guild should treat `~/.agents/skills` and repo
`.agents/skills` as first-class (Codex-compatible) so one skill directory
serves codex, pi, and Guild.

## 2. Guild today (what exists, what doesn't)

Exists and works:
- `guild-core/src/registry.rs`: bundle pack/unpack, `pack_skill` (requires
  SKILL.md, slug = dir name, description from frontmatter), manifest with
  Guild metadata (id, version, review status — never inside SKILL.md).
- Server registry API + Postgres tables + S3 bundle storage; review flow
  (SkillSpector pending/approved/denied; denied blocks install — SRS FR-7.5).
- `app-server/src/registry_client.rs::install_skill` → unpacks into
  `{project}/.guild/skills/{slug}/`, returns a `SkillEntry`.
- `app-server/src/skills.rs`: `discover(project_dir, config_dir)` +
  `prompt_index(skills)` with frontmatter parsing and tests.

Dead / missing:
- `agent.start` in `jsonrpc_loop.rs` passes `system: None` — no skills index
  ever reaches the model. Discovery is never called outside tests.
- No explicit-invocation path (`$name` mention → load full SKILL.md).
- No index budget.
- No `.agents/skills` discovery (Codex/pi repo+user scopes).
- No per-skill enable/disable.

Architecture constraint (drives the design): the system prompt is
**server-owned by design** (`build_system_prompt` in
`server/src/worker/restate.rs`; "the client never sends one"). But skills
live on the client machine (desktop executor runs tools client-side), so the
server cannot discover them. The index must be computed client-side and
arrive through an **additive, server-capped** channel — the server keeps
ownership of the prompt, the client may only append a bounded segment.

## 3. Target behavior

1. On `agent.start`, app-server discovers skills and renders the index into
   the system prompt (via the additive channel). The index lists
   name — description (path) and one instruction line: "when a task matches
   a skill, read its SKILL.md with read_file and follow it".
2. Implicit invocation: the model reads the full SKILL.md via `read_file`
   when a task matches. `read_file` on skill paths must not require
   approval (it is already read-only).
3. Explicit invocation: a `/name` token in the user prompt (word-start
   position, `name` matching a discovered skill) injects the full SKILL.md
   body as a context block for that turn. No approval, no tool call needed.
   The composer autocompletes on `/`.
4. Freshness: re-discover at every `agent.start`. A watcher + `skills/changed`
   event is later polish, not v1. The desktop skills manager (skills.list /
   skills.disable JSON-RPC + settings section) and the composer `/`
   autocomplete shipped 2026-09-16 alongside T1–T7.
5. Disable: per-skill toggle in Guild settings (persisted as path → enabled
   map); disabled skills are skipped at discovery. Simple UI later; config
   only in v1.
6. Install and uninstall operate on the same directories the loader reads
   (§4): a registry install goes to repo `.agents/skills/<slug>` by default,
   or `$HOME/.agents/skills/<slug>` for a user-scoped (global) install —
   chosen per install, like npm local vs -g. Uninstall removes the skill
   directory, but only when Guild provenance says Guild put it there (§5).
7. Provenance: every skill dir carries a Guild provenance sidecar
   (`agents/guild.yaml`) distinguishing guild-authored, locally-authored
   unpublished, and registry-installed skills (§5).

## 4. Scope layout and precedence

Discovered per agent.start (first match on name wins; project beats user —
keep Guild's current merge rule, a deliberate deviation from Codex's
"show duplicates"):

Reading and installing use the same directories:

| Scope | Location | Loader | Installer |
|---|---|---|---|
| repo | `.agents/skills` from cwd up to repo root | read | install target (default) |
| user | `$HOME/.agents/skills` | read | install target (`global = true`) |
| legacy | `{project}/.guild/skills` and `{config}/guild/skills` | read (deprecated fallback) | never installed into |

The legacy scopes keep previously installed skills working after the
loader switches; new installs always land in `.agents/skills` so one
directory serves Guild, codex, and pi. ADMIN/SYSTEM scopes are out of scope
for v1. Skill bundles from plugins/marketplaces: out of scope (the registry
is Guild's distribution channel).

Windows note: `$HOME/.agents/skills` resolves to the user profile
(`C:\Users\<name>\.agents\skills`) via the platform home-dir call; the repo
walk is relative and OS-independent.

## 5. Provenance (agents/guild.yaml)

Guild metadata stays out of SKILL.md (same principle as the bundle
manifest). Provenance lives in a sidecar at `<skill-dir>/agents/guild.yaml`
— the same convention Codex uses for its optional `agents/openai.yaml`, and
a file other harnesses ignore:

```yaml
source: registry        # registry | local
slug: deploy-check
version: 0.3.1
org: <org id>           # registry-sourced only
publisher: <user id>    # who published the installed version
published_by_me: false  # true when this user published it
review_status: approved
installed_at: 2026-09-16T12:00:00Z
bundle_hash: sha256:…
```

Rules:

- **Registry install** unpacks the bundle and writes the sidecar. The
  bundle manifest is the source; the sidecar is its on-disk projection.
- **Local authoring** creates no sidecar. The dir is a plain SKILL.md
  folder exactly like a codex/pi-authored skill — full interoperability.
- **Publish** ("publish my skills to the org registry") packs the dir,
  pushes the bundle, then writes/updates the sidecar with
  `source: registry, published_by_me: true`. From then on the dir is
  linked to its registry identity (slug/version shown in the UI, update
  pulls the new version).
- **Uninstall** deletes the skill dir only when a sidecar with
  `source: registry` is present. A dir without a sidecar (or with
  `source: local`) is refused — Guild never deletes skills it did not put
  there, which is what makes sharing these dirs with codex and pi safe.
- **Local edits** to an installed skill are detected by comparing the file
  hash against `bundle_hash`; the UI shows "modified locally". Update
  (re-install of a newer version) overwrites and refreshes the sidecar.
- Loader precedence is unchanged (project/repo wins over user); provenance
  plays no role in loading, only in install/uninstall/publish and UI
  labeling.

## 6. Index budget

Same rule as Codex: cap the rendered index at 2% of the model's context
window, 8,000 chars when the window is unknown (Guild: 8,000 chars flat in
v1 — the gateway does not reliably expose context windows per model). When
over budget, truncate descriptions first (front-loaded trigger wording
survives, per the Codex best practice), then drop entries from the end and
append a warning line "N skills omitted".

## 7. Implementation plan

- **T1 — additive gateway channel**: add `skills_index: Option<String>` to
  `ChatCompletionRequest` (protocol crate). Server: in the completion
  handler, append it to `build_system_prompt` output after trimming, then
  hard-cap at 8k chars server-side (the server stays the enforcement point).
  Client-sent system prompt remains forbidden; this field is append-only
  content, never overriding persona or tool instructions.
- **T2 — app-server wiring**: in `agent.start` (jsonrpc_loop.rs), replace
  `system: None` plumbing: call `skills::discover(project_dir, config_dir)`,
  apply the disable list, render `prompt_index` with the budget, pass it as
  `skills_index` on the `ChatCompletionRequest` (via `GatewayTurn`).
- **T3 — `/name` explicit invocation** (trigger char changed from the Codex
  `$` to `/` per user decision): in app-server's turn assembly, scan
  the user prompt for `/`-prefixed tokens at word start (start of text or
  after whitespace — URLs and paths don't fire it) matching discovered
  skill names;
  for each match, append a context block (`Skill: <name> (<path>)\n\n<body>`)
  to the turn's context (as part of the user message, separated by a clear
  delimiter — the system channel stays server-owned). Unknown `$token` passes
  through untouched.
- **T4 — discovery scopes**: extend `skills::scan_dir`/`discover` with the
  `.agents/skills` repo walk (cwd → repo root) and `$HOME/.agents/skills`;
  keep `.guild/skills` install target; config-dir scope becomes fallback.
- **T5 — disable list**: settings-backed `path → enabled=false` map applied
  in `agent.start` after discovery. No UI in v1.
- **T6 — install target + uninstall**: `registry_client::install_skill`
  unpacks into `.agents/skills/<slug>` (repo scope by default, user scope
  when `global = true`), writes the `agents/guild.yaml` sidecar from the
  bundle manifest; new `uninstall_skill(slug, global)` verifies the
  sidecar before removing the dir. Legacy `.guild/skills` dirs stay
  readable, never written.
- **T7 — publish writes provenance**: the publish flow packs the dir and
  writes/updates the sidecar (`source: registry`, `published_by_me: true`,
  slug, version, hash). Local-edit detection: hash compare at chat start
  or on demand in the skills UI.
- **T8 — tests**: index reaches the model (scripted provider asserts system
  contains the index); budget truncation; `$name` injection; `.agents/skills`
  discovery + precedence; disabled skill excluded; server caps oversized
  `skills_index`; denied skills never appear (install-side already blocks);
  sidecar round-trip (install → provenance → uninstall); uninstall refuses
  dirs without a registry sidecar; publish marks `published_by_me`.
Sequencing: T1+T2 make skills visible (the actual bug); T3 is the ergonomic
core of the Codex model; T4/T5 are small follow-ups. Watcher, skill-creator
skill, `$` autocomplete in the composer, `agents/openai.yaml` metadata: all
deferred.

## 8. Non-goals (v1)

- Server-side skill discovery for server-executed tool flows (web clients
  without a desktop executor) — revisit when remote execution backends land.
- Plugin/marketplace-bundled skills; ADMIN (`/etc/guild/skills`) scope.
- skills watcher + live `skills/changed` push to the UI.
- Skill commands (`/skill:name`) — `/name` covers explicit invocation.
