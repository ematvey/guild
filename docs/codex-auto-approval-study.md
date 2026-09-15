# How Codex (openai/codex) does auto-approval — study notes

Source: shallow clone of github.com/openai/codex (codex-rs workspace), read
2026-09-15. Paths referenced below are inside `codex-rs/`.

## The big picture: three layers, not one judge

Guild's `approve_for_me` is one thing: a single model call that sees the
action JSON and answers allow/ask. Codex splits the same problem into three
layers, cheapest first:

1. **Static command policy (execpolicy)** — deterministic, no model.
   - `execpolicy/` crate: Starlark rules, one decision per command:
     `prefix_rule(pattern=["git", ["status","log","diff"]], decision="allow"|"prompt"|"forbidden")`.
   - The command string is split into segments at shell control operators
     (pipes, `&&`, `;`, subshells); each segment is evaluated independently.
     Commands with redirections, substitutions, env assignments, or globs are
     NOT evaluated against rules (deliberately — limits what an approved rule
     can be stretched to cover).
   - `host_executable(name="git", paths=[...])` constrains basename fallback
     to known absolute paths.
   - Where used: read-only defaults run without approval; `prompt` rules
     trigger the approval flow; `forbidden` blocks outright.

2. **Sandbox-first execution** — the default mode never asks for permission
   to run things that fit in the sandbox.
   - Default `AskForApproval::OnRequest` ("the model decides when to ask"):
     every command first attempts inside an OS sandbox (restricted FS writes,
     network rules). Sandboxed runs need NO approval.
   - Escalation is an explicit model signal: the shell tool takes
     `sandbox_permissions: "require_escalated"` + a `justification`
     (a user-facing question). The model is instructed to escalate when
     sandboxing fails (DNS/registry/download errors), when it must write
     outside writable roots, run GUI apps, or is about to do something
     destructive the user did not ask for.
   - Escalation requests may propose a persistent `prefix_rule` the user can
     accept once and keep (banned examples: bare `["python3"]`, `["python","-"]`;
     never propose a prefix_rule for destructive commands like `rm`).
   - Patch safety (`core/src/safety.rs`): `apply_patch` auto-approves when
     every touched path is inside sandbox-writable roots
     (`SafetyCheck::AutoApprove`); rejects when the policy forbids; asks
     otherwise. Comment in code: patches can be hard-link tricks, so the patch
     still executes in a sandbox even when auto-approved.

3. **The AI judge ("Guardian")** — an OPTIONAL reviewer, configured
   separately from the approval mode.
   - `ApprovalsReviewer = user (default) | auto_review`. With
     `auto_review` and policy OnRequest/Granular, every approval request
     (escalations, execpolicy `prompt` rules, network denials, MCP
     elicitations) goes to a reviewer subagent instead of the user
     (`ext/guardian-reviewer/src/routing.rs: routes_approval_policy_to_guardian`).
   - NOT a single classify call. It is a full subagent session spawned through
     the same ThreadManager as the main agent
     (`ext/guardian-v2/src/sync_reviewer/mod.rs`), with:
     - context collection with token budgets: conversation transcript,
       tool descriptions, permission context, prior guardian decisions
       (`core/src/guardian_context` crate; `input_budget.rs`);
     - runs on a dedicated OS thread, 90s deadline (`REVIEW_TIMEOUT`),
       up to 3 attempts, a reviewer session pool, and a circuit breaker
       (`ext/guardian-reviewer/src/{deadline,rRetry,pool,circuit_breaker}.rs`);
     - output contract: `GuardianAssessmentOutcome = allow | deny` plus
       reasons, emitted as a typed schema (`guardian_output_schema`).
   - Fail direction: timeout/abort/deny NEVER silently allows. "No
     contributor is never an implicit allow" — denial or timeout falls back
     to the normal user prompt (`decision.rs`: `None` → existing user flow).
   - The prompt is a large risk-taxonomy document, bundled as a markdown
     asset and reviewable as a file (`core/assets/guardian/policy.md`):
     data exfiltration (trace payloads to destinations; untrusted SaaS is
     never trusted by default), credential probing, persistent security
     weakening, destructive actions (incl. shadowed `HOME`, protected-branch
     git pushes, "user tasks do not authorize all steps"), and low-risk
     actions. A tenant-configurable section is spliced into the template.
   - The main agent's instructions change accordingly
     (`prompts/src/permissions_instructions.rs`): the model is told
     escalations are auto-reviewed, and a rejection means "proceed only with
     a materially safer alternative, or inform the user of the risk".

4. **Approval caching** — `with_cached_approval` keys per action; an
   "approve for session" is stored per key so identical/succeeding-subset
   calls skip prompting for the rest of the session.

## Differences vs Guild's approve_for_me

| Aspect | Guild | Codex |
|---|---|---|
| Judge | one model call, same chat model, action JSON only | optional subagent with transcript context, dedicated policy prompt |
| Latency per gated tool | ~2–5s model call, every gated tool | sandboxed exec: 0 (no gate); static rules: ~0; judge only on escalations |
| Fail direction | no verdict → ask user card | same (never implicit allow), plus circuit breaker |
| Context the judge sees | tool name + arguments | conversation, authorization evidence, tool metadata |
| Read-only fast path | none — everything gated (except force_ask overrides) | static allowlist + sandbox makes most calls ungated |
| Persistent grants | per-chat mode + account policy + per-tool curation | session approval cache + persisted prefix_rules |
| Cost | judge call per tool | judge call per escalation only |

## Ideas worth stealing for Guild

1. **Static pre-classifier before the judge**: an allowlist of obviously
   read-only commands (`date`, `ls`, `cat`, `git status`…) and a small
   denylist (rm -rf, drop database, force-push…) decided in microseconds;
   only the middle band goes to the judge. Cuts judge latency and cost for
   the common case and makes the judge's role "hard cases only".
2. **Give the judge conversation context**: Guild's judge sees only
   `{tool, arguments}`. Codex weighs USER AUTHORIZATION explicitly (what did
   the user actually ask for). Sending the last few user messages (or the
   current turn's request) would let the judge distinguish "user asked for
   exactly this" from "model invented this".
3. **Judge verdict with a reason surfaced to the model** on deny: Guild
   returns a bare card; Codex feeds the denial reason back so the model can
   pick a safer alternative instead of retrying the same call.
4. **Session-scoped approval cache**: an "allow this exact command for this
   chat" choice already exists via cards; a per-chat cache keyed by
   canonicalized command would remove repeat cards.
5. **Never implicit allow on judge failure** — Guild already matches this
   (timeout/error → ask). Keep it.

## Addendum: per-command sandboxing (same study)

Every shell exec is a `SandboxCommand` → `SandboxManager::transform`
(`sandboxing/src/manager.rs`) which picks a platform backend per command:

- `SandboxType`: `MacosSeatbelt` / `LinuxSeccomp` (bubblewrap) /
  `WindowsRestrictedToken` / `WindowsMxc` / `None`.
- **Linux**: the command re-execs through the `codex-linux-sandbox` helper
  (arg0 detection). Filesystem sandbox = bubblewrap (system `bwrap` if new
  enough, else a bundled copy; user namespaces; full FS read-only, writes
  only in cwd/writable roots). In-process: `PR_SET_NO_NEW_PRIVS` + a seccomp
  filter (seccompiler) that blocks raw network egress (or routes it through
  the proxy). Legacy Landlock path kept as an explicit fallback
  (`use_legacy_landlock=true`); WSL1 unsupported, WSL2 fine.
- **macOS**: `sandbox-exec` with Seatbelt SBPL profiles composed from
  bundled `.sbpl` fragments (`seatbelt_base_policy.sbpl`, network,
  preferences, read-only platform defaults) plus per-profile writable roots.
- **Windows**: their own restricted-token sandbox (`windows-sandbox-rs`,
  ACL-based) or Microsoft's MXC container runner (`mxc-sandbox`).
- **Network per command**: a local MITM proxy (`network-proxy`, HTTP
  127.0.0.1:3128 / SOCKS5 8081) with allow/deny ACLs and a "limited"
  read-only-network mode. Sandboxed processes get proxy env vars; seccomp
  makes the proxy the only egress route, so domain-level network policy is
  enforced per command; the MITM CA bundle is added as a readable root.
- **Escalation**: a sandboxed failure doesn't ask the user — the model
  re-issues the command with `require_escalated`; that request goes to the
  user (or Guardian). Approved commands are cached per canonicalized
  command-key for the session.

Guild note: our desktop executor runs machine tools unsandboxed on the
user's machine (Windows/mac). Per-command OS sandboxing is the piece we
cannot cheaply replicate there; the realistic steals are the network-proxy
idea (per-tool domain ACLs for server-side fetch tools) and segment-level
assessment of compound commands.
