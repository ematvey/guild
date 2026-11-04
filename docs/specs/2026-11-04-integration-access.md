# Integration access

Status: proposed. Builds on [002 Access](../domain/002-access.md) and
[004 Capabilities](../domain/004-capabilities.md); when it lands, those two
documents change in the same commit.

## Problem

An enabled Integration reaches every Member. The only gates are per-tool
curation, the role × class rule (`member` gets `read`, `admin` gets all) and
each Agent's allowlist, where `tools_mode = all` picks up every enabled
Integration on its own.

Nine of the ten built-ins call their vendor with one shared org token
(`auth_kind: org_secret`) and ignore the acting identity. Google Workspace
is the only one that impersonates. For the shared-token Integrations,
Guild's gate is the only boundary, and it cannot say "HubSpot is for Sales".
HubSpot is the case that matters: revenue, deals and pipeline sit there, and
today any Member's agent can search them.

## Decisions

1. **An Integration has an audience.** Like Agent visibility, it is one of
   `org`, `team` (with team grants) or `admins`. A new Integration starts at
   `admins`.
2. **An Agent lists its Integrations explicitly.** `tools_mode = all`
   covers built-in tools only. An Integration reaches an Agent only when it
   is in the Agent's Integration list, so enabling an Integration reaches no
   Agent by itself. This applies to personal Agents too.
3. **Only someone in an Integration's audience can add it to an Agent**,
   and only if they can manage that Agent. Removing an Integration from an
   Agent needs only manage.
4. **The Agent's configuration supersedes the caller's grants.** A Turn sees
   the Integrations its Agent lists, whoever sends the message. Who may use
   them is decided by who may use the Agent (its visibility and team
   grants), and the Integration's audience is not re-checked per caller.
   Access is gated twice, by the same team mechanism: once on the
   Integration (who may attach it) and once on the Agent (who may use it).
5. **Mismatches warn and do not block.** When an Agent's audience is wider
   than the audience of an Integration it lists, the Agent settings and the
   Integration's page show a warning that names the Integration and the
   teams that gain reach through the Agent. Nothing composes the two
   permissions at call time.
6. **The class ceiling moves to the Agent's entry.** Each Agent Integration
   entry carries a ceiling (`read`, `write`, `admin`), which can be no
   higher than the ceiling the Integration's audience grants the person who
   adds it. It replaces the per-role `tool_policy`. `admin`-class tools stay
   admin-only at call time, whatever the Agent says.
7. **Curation, approvals and audit are unchanged.** Per-tool enable,
   `always_ask` / `always_allow`, and the `integration.tool_called` event,
   which gains the Agent id.

### At call time

A tool of Integration `I` is offered to a Turn of Agent `A` for Member `M` when:

- `I` is enabled and the tool is curated on;
- `A` lists `I`, and the tool's class is within `A`'s ceiling for `I`;
- the tool is not `admin`-class, or `M` is an admin.

That replaces `toolAllowed`'s role × class check
(`apps/server/src/integrations/policy.ts`). Routines and delegation follow
unchanged: a Run already refuses to start for a Member who can no longer
use its Agent.

### Data

- `integration_grants (org_id, integration, team_id, ceiling)` and an
  `audience` column on `integrations` (`org` | `team` | `admins`); for
  `org`, an org-wide ceiling.
- `agent_integrations (agent_id, integration, ceiling, added_by, added_at)`.
- Migration: for every Agent with `tools_mode = all`, write entries for the
  Integrations enabled now, with the ceiling today's role rule would give
  its owner. Existing Integrations get audience `org`. Behavior does not
  change until an admin narrows an audience, and the migration then shows
  the warnings an admin needs to act on.
- Grant and Agent-entry changes are operational state: they push a
  `ServerFrame` (the Integrations page, Agent settings and the warning
  badges are all live), per the conventions in `AGENTS.md`.

## Gating HubSpot with this

1. Set HubSpot's audience to `team`: Sales at `write`, Leadership at `read`.
2. Add HubSpot to the Sales team's Agent. The Agent is visible to Sales
   only, so there is no warning.
3. If someone adds HubSpot to an `org`-visible Agent, both pages warn that
   every Member reaches HubSpot through that Agent.

The private-app token's scopes remain the outer limit. A token without
`crm.objects.deals.read` keeps revenue out of every Agent, whatever the
grants say.

## Phase 2: several connections per vendor

A slug holds one row and one secret set today: the primary key is
`(org_id, name)` (`migrations/0018_integrations.sql`), and secrets are keyed
the same way. Resource scoping (an infra-only GitHub token, a HubSpot token
without deals) needs several connections per slug, each with its own
credential, audience and label, and tool names that include the connection.
No Guild-side argument filters: scoping comes from the vendor token.

## Phase 3: member identity without OAuth

Use the Member's sign-in identity as the key, with no per-Member account
connection. The Integration declares a mode, which replaces `auth_kind`:

| Mode | How | Candidates |
| --- | --- | --- |
| `impersonated` | The admin credential calls as the Member | Google Workspace (domain-wide delegation), GitLab (`Sudo` header) |
| `mirrored` | Look the Member up by email and check the vendor's own permission before or after the call | GitHub, Slack, Jira/Confluence, Grafana |
| `shared` | One identity for all callers, gated by audience only | HubSpot, Langfuse, SearXNG, Firecrawl |

Rules: an unresolved identity refuses the call; an admin can store a
per-Member, per-Integration identity override; a `mirrored` Integration
exposes no raw-API tool. The vendor endpoints are to be verified before this
phase is planned.

## Known gaps

- **Shared Workspaces carry data across callers.** An Agent's Workspace is
  shared by everyone who uses it (001). Anything one caller's Turn fetches
  and writes there, any later caller of the Agent can read. Decision 4
  accepts this: the Agent is the unit of access, and its audience is what
  the warning in decision 5 checks.
- **Google Workspace falls back to the admin email** when a call has no
  Member identity. It should refuse. Fix this independently of the rest.
- **Per-member OAuth** (each Member connects their own vendor account) is
  out of scope.

## Rejected

| Rejected | Reason |
| --- | --- |
| Composing Agent and caller permissions at call time | Two Members would get different tools from one Agent, and the Workspace leaks anyway. The warning makes the mismatch visible instead |
| Guild-side argument filters (repo, channel or pipeline allowlists) | Per-vendor, easy to get wrong, and the raw `api` tool goes around them. The vendor token is the scope |
| `tools_mode = all` covering Integrations | An Integration enabled for one team would reach every `all` Agent with no one deciding it |
