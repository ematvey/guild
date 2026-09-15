# Exec-policy gate (Codex model) Implementation Plan

> **For agentic workers:** execute task-by-task, TDD, commit per task.

**Goal:** A static Starlark prefix-rule layer (Codex execpolicy, vendored)
decides `execute` tool calls before the approval gate: `allow` → run with no
gate, `forbidden` → deny with the rule's justification, everything else → the
existing judge/card flow unchanged.

**Architecture:** New module `crates/server/src/worker/exec_policy_gate.rs`
owns a `LazyLock<Policy>` parsed from two embedded rules files and exposes
`evaluate_execute(args) -> ExecPolicyDecision`. `client_tool_step` in
`restate.rs` calls it before `approval_gate`. Pure function of embedded
content + command string → safe under Restate replay (same binary, same
rules).

**Tech Stack:** vendored `codex-execpolicy` (starlark 0.14), `shlex` for
tokenization.

**Spec:** `docs/codex-auto-approval-study.md` (Codex study) + this thread's
agreed mapping (allow→skip, forbidden→deny+justification, prompt/unmatched→
judge/card; no user questions).

## Global Constraints

- Unmatched commands and untokenizable commands fall to `Prompt` (judge) —
  never allow (no sandbox backs the fallback on the desktop executor).
- Segments: split the token stream at `&&`, `||`, `;`, `|`; any segment
  containing a redirection token (`<`, `>`, `>>`, `<<`) is `Prompt` — static
  rules must not wave through writes.
- `forbidden` decisions always carry a `justification` in the rules file; the
  denial text is the justification.
- Rules are compile-time embedded (`include_str!`) — no runtime file loads on
  the decision path (replay determinism).
- `approve & remember` (persisting new allow rules from cards) is explicitly
  OUT of scope for this plan.

---

### Task 1: Vendored crates compile

**Files:** already copied: `crates/codex-execpolicy/`,
`crates/codex-utils-absolute-path/`; `Cargo.toml` (workspace members).

- [x] Step 1: workspace members + Cargo.tomls written (edition 2024 kept —
      rustc 1.97 supports it per-crate).
- [x] Step 2: `cargo check -p codex-execpolicy -p codex-utils-absolute-path`
- [x] Step 3: `cargo test -p codex-execpolicy` (crate ships its own tests)
- [x] Step 4: commit `feat: vendor codex execpolicy crate`

### Task 2: exec_policy_gate module (TDD)

**Files:**
- Create: `crates/server/src/worker/exec_policy_gate.rs`
- Create: `crates/server/assets/exec_policy_base.rules`
- Create: `crates/server/assets/exec_policy_local.rules` (extracted from
  `~/.codex/rules/default.rules`)
- Modify: `crates/server/src/worker/mod.rs` (module declaration)
- Modify: `crates/server/Cargo.toml` (deps: codex-execpolicy, shlex)

**Interfaces:**
- Produces: `pub enum ExecPolicyDecision { Allow, Deny(String), Prompt }`;
  `pub fn evaluate_execute(arguments: &serde_json::Value) -> ExecPolicyDecision`.

- [x] Step 1: write failing tests (module missing → RED):
  - `date` → Allow
  - `rm -rf /` → Deny containing justification
  - `git status && rm -rf /` → Deny (strictest segment wins)
  - `echo hi > /tmp/x` → Prompt (redirection guard)
  - `blinkenlights --now` (unmatched) → Prompt
  - `journalctl --user -u docker` (local.rules match) → Allow
  - unbalanced quote → Prompt
  - `{"cwd": "x"}` (no command field) → Prompt
- [x] Step 2: watch RED (`cargo test -p guild-server exec_policy_gate`)
- [x] Step 3: implement module + rules files → GREEN
- [x] Step 4: watch GREEN; full `cargo test -p guild-server` unaffected
- [x] Step 5: commit

### Task 3: wire into client_tool_step

**Files:**
- Modify: `crates/server/src/worker/restate.rs` (client_tool_step, before
  the approval_gate call)

- [x] Step 1: wiring: only for `execute` calls; `Allow` → skip approval_gate
  entirely; `Deny(reason)` → return the denied ToolResultPayload (same shape
  as the Approval::Never path); `Prompt` → existing flow untouched.
- [x] Step 2: `cargo check -p guild-server` + full test suite
- [x] Step 3: commit `feat(worker): exec policy gate ahead of approval gate`

### Task 4: docs + deploy + live verify

- [x] PLAN.md entry (comment principle: what it IS/DOES, no history)
- [x] compose build+up detached; verify: health OK
- [x] Live verify: curl turn with `execute date` → judge log ABSENT, tool
  runs; `execute` with a forbidden command → denied-by-policy tool result,
  no card, no judge.

## Self-review

- Spec coverage: allow/forbidden/prompt mapping ✓; segment+redirection ✓;
  replay determinism ✓; no new user-facing UI ✓.
- No placeholders; interfaces pinned above.


### Task 5: wording audit (post-ship)

- [x] Verified per-mode behavior against the composer hints. One deviation:
      ask-mode's hint claimed it gates internet use — read-class internet
      tools (search/browse/fetch) flow ungated in every mode by design.
      Fixed the hint, not the behavior (reads-flow is the standing design;
      codex's strict modes also let static allow rules through).
- [x] full_access hint now names its two intentional exceptions (org-pinned
      tools, exec-policy forbidden).
