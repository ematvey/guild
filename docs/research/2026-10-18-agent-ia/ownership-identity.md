# Identity and permission models for persistent agents

Scope: Guild's persistent agents — org-owned, with workspace, threads, routines,
and later agent-to-agent calls. Focus: who the agent acts as, what it may touch,
and how that survives people leaving.

## 1. Identity models compared

| Model | Acts as | Pros | Cons | Examples |
|---|---|---|---|---|
| Service identity | Itself, own grant | Durable; unattended; survives creator leaving | Broad standing access; confused deputy; needs an owner | GitHub App installation; Slack bot token (`xoxb`); Google service account |
| Delegated / on-behalf-of | The invoking user, narrowed | Boundaries come free; revocation automatic; per-call least privilege | No unattended runs; results differ per caller | OAuth OBO; Google domain-wide delegation; Slack user token |
| Scoped-down service token | Itself, per-task subset | Bounded blast radius; short TTL | Needs a token service; scope logic is real work | GitHub installation token with `repositories` + `permissions` (1 h) |
| Agent principal + actor claim | Itself, "acted for X" recorded | Durable and attributable; routines and turns share one identity | Two checks per call; intersection is easy to get wrong | Entra Agent ID; RFC 8693 `act` claim |
| Membership-scoped bot | Itself, limited to joined spaces | Matches sharing mental model; no org-wide read | Membership drift; borrowed-visibility edges | Slack bot in channels; workflow tokens |

Evidence:
- GitHub installation tokens downscope per request to a repo list and permission
  subset, and expire in one hour.
- Slack bot tokens are not tied to a user, so the app survives installer
  deactivation. Good continuity, weak attribution unless the actor is logged.
- Slack workflow tokens show "borrowed visibility": a run sees a private channel
  only because the starting user is in it. Cleanest production example of a
  per-run, user-conditioned scope.
- Microsoft OBO passes only delegated scopes down. The agent never gains
  rights the user lacks.
- Entra Agent ID splits **owner** (technical admin) from **sponsor** (business
  accountable, does access reviews) — a direct answer to orphaned agents.

## 2. Authorization patterns for an agent collection

1. **Two subjects per action**: `agent_id` and `actor` (`user:<id>`, `routine`,
   `agent:<id>`). Log both; authorize on both.
2. **Intersection, never union**: effective rights = agent grant ∩ actor's
   rights. A shared agent must not become an escalation path.
3. **Roles on the agent resource**: owner (delete, grants, model), operator
   (run, edit routines, read threads), viewer (read). New members get nothing;
   sharing is explicit.
4. **Capability profile per agent**: tools, model, egress allowlist, quota.
   Start small; widening is an admin action.
5. **Approval gates** for irreversible or external effects. Static rules first,
   then a human. The agent proposes; the human authorizes.
6. **Deny cross-agent by default.** A2A needs an explicit grant and a
   downscoped token naming both parties.

## 3. Data boundaries

- **Threads**: an agent's threads are its own; `conversations_search` filters by
  `agent_id` (Guild's spec already does this). A user sees a thread only if they
  can see the agent, or it was explicitly shared.
- **User private chats are out of scope.** No agent reads human-to-human
  conversations in M1. Org knowledge comes from granted projects, not transcript
  mining.
- **Workspace** is one agent's boundary: per-agent subpath mount, no sibling
  workspace visible. Cross-agent file access only by explicit share.
- **Routines** run without a user. Give them a fixed narrower grant: own
  workspace, own threads, delivery to the routine's audience. Never the owner's
  full interactive scope.
- **Deletion**: archive freezes runs; delete purges workspace, threads, tokens,
  and records who did it.

## 4. Three models Guild could adopt

**A. Org-owned service agent.** Standing grants; any `operator` can use it.
*Pros*: routines just work; one identity. *Cons*: confused deputy is live; a
prompt-injected thread acts with the full grant; offboarding needs governance.

**B. Pure delegation.** Every run uses the caller's downscoped token. *Pros*:
strongest isolation; automatic revocation. *Cons*: no unattended routines;
shared agents behave differently per caller.

**C. Hybrid (recommended).** Agent is a principal with a narrow baseline grant
(own workspace, own threads, model, no egress). Interactive runs mint a per-turn
scope bound to `(agent, user, thread)`. Routines use the baseline plus an
explicit delivery target. *Pros*: unattended work and least privilege; clean
audit. *Cons*: a scope service and two checks per call.

## 5. Recommendation for M1

Adopt **C**, minimal form:

- `agents(org_id, owner_user_id)` plus `agent_grants(agent_id, user_id, role)`.
  Single owner; transfer is an admin action.
- Every run carries `actor_kind`, `actor_user_id`, `trigger`. The activity log
  already exists — add actor fields and a decision record per tool call.
- Interactive read scope = agent baseline ∩ actor's access. Write scope = agent
  baseline only.
- Routines: baseline grant, owner-only delivery. If the owner leaves the org,
  suspend routines and flag the agent for reassignment; do not delete.
- Deny cross-agent access and org-wide transcript search. Keep exec policy in
  front of every shell call.
- One approval gate for external side effects. Not a policy language.

Defer: RFC 8693 token exchange, per-thread ACLs, multi-owner/sponsor governance,
A2A delegation, per-tool scopes beyond the profile.

## 6. Sources

- OWASP Top 10 for Agentic Applications 2026 (ASI01, ASI03) —
  https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/ ;
  https://genai-security-project.github.io/crosswalk/agentic-ai-top10/
- GitHub App installation tokens —
  https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app
- Slack token types, bot/user, borrowed visibility —
  https://docs.slack.dev/authentication/tokens/
- Microsoft OBO —
  https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-on-behalf-of-flow
- Entra Agent ID owners/sponsors —
  https://learn.microsoft.com/en-us/entra/agent-id/manage-owners-sponsors-agents ;
  inheritable permissions —
  https://learn.microsoft.com/en-us/entra/agent-id/concept-inheritable-permissions
- AWS confused deputy, external ID —
  https://docs.aws.amazon.com/IAM/latest/UserGuide/confused-deputy.html
- RFC 8693 Token Exchange — https://www.rfc-editor.org/rfc/rfc8693.html
- Google Workspace service accounts, domain-wide delegation —
  https://developers.google.com/workspace/guides/create-credentials
- Guild internal: `docs/specs/2026-10-18-persistent-agents.md`
