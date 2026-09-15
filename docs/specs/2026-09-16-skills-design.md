# Skills design — modeled after Codex

2026-09-16. Verified against: pi docs (`docs/skills.md`), OpenAI Codex docs
(developers.openai.com/codex/skills) + codex-cli 0.154.0 binary strings, and
the Guild codebase.

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
3. Explicit invocation: a `$name` token in the user prompt (where `name`
   matches a discovered skill) injects the full SKILL.md body as a context
   block for that turn. No approval, no tool call needed.
4. Freshness: re-discover at every `agent.start`. A watcher + `skills/changed`
   event is later polish, not v1.
5. Disable: per-skill toggle in Guild settings (persisted as path → enabled
   map); disabled skills are skipped at discovery. Simple UI later; config
   only in v1.

## 4. Scope layout and precedence

Discovered per agent.start (first match on name wins; project beats user —
keep Guild's current merge rule, a deliberate deviation from Codex's
"show duplicates"):

| Scope | Location | Notes |
|---|---|---|
| install | `{project}/.guild/skills/<slug>/` | registry install target (exists) |
| repo | `.agents/skills` from cwd up to repo root | Codex + pi compatible |
| user | `$HOME/.agents/skills` | shared with codex + pi on this machine |

`config_dir/skills` (current user scope, `{config}/guild/skills`) stays as a
deprecated fallback behind the new user scope. ADMIN/SYSTEM scopes are out
of scope for v1. Skill bundles from plugins/marketplaces: out of scope (the
registry is Guild's distribution channel).

## 5. Index budget

Same rule as Codex: cap the rendered index at 2% of the model's context
window, 8,000 chars when the window is unknown (Guild: 8,000 chars flat in
v1 — the gateway does not reliably expose context windows per model). When
over budget, truncate descriptions first (front-loaded trigger wording
survives, per the Codex best practice), then drop entries from the end and
append a warning line "N skills omitted".

## 6. Implementation plan

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
- **T3 — `$name` explicit invocation**: in app-server's turn assembly, scan
  the user prompt for `$`-prefixed tokens matching discovered skill names;
  for each match, append a context block (`Skill: <name> (<path>)\n\n<body>`)
  to the turn's context (as part of the user message, separated by a clear
  delimiter — the system channel stays server-owned). Unknown `$token` passes
  through untouched.
- **T4 — discovery scopes**: extend `skills::scan_dir`/`discover` with the
  `.agents/skills` repo walk (cwd → repo root) and `$HOME/.agents/skills`;
  keep `.guild/skills` install target; config-dir scope becomes fallback.
- **T5 — disable list**: settings-backed `path → enabled=false` map applied
  in `agent.start` after discovery. No UI in v1.
- **T6 — tests**: index reaches the model (scripted provider asserts system
  contains the index); budget truncation; `$name` injection; `.agents/skills`
  discovery + precedence; disabled skill excluded; server caps oversized
  `skills_index`; denied skills never appear (install-side already blocks).

Sequencing: T1+T2 make skills visible (the actual bug); T3 is the ergonomic
core of the Codex model; T4/T5 are small follow-ups. Watcher, skill-creator
skill, `$` autocomplete in the composer, `agents/openai.yaml` metadata: all
deferred.

## 7. Non-goals (v1)

- Server-side skill discovery for server-executed tool flows (web clients
  without a desktop executor) — revisit when remote execution backends land.
- Plugin/marketplace-bundled skills; ADMIN (`/etc/guild/skills`) scope.
- skills watcher + live `skills/changed` push to the UI.
- Skill commands (`/skill:name`) — `$name` covers explicit invocation.
