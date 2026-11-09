# 002 Access

Access decides who may see and change what, and on whose behalf a Run acts. This document builds on [001 Domain model](001-domain.md).

The server enforces every rule here. Messages, tool results and prompts are inputs to a Turn; they cannot widen what a Member, an Agent or a Run may do.

## Identities and credentials

A Member signs in with a `managed` password or through the Org's one OIDC provider. An OIDC login matches only an email the provider verified. A password account with the same email is refused, never linked. An OIDC Member starts as `member`.

Every credential is stamped with the Member's **auth generation** when it is issued, and it is valid only while that generation is current:

| Credential | What it is | Lifetime |
| --- | --- | --- |
| Login session | The opaque bearer token of one browser or desktop client, stored hashed | 30 days, sliding |
| API key | A bearer key for the gateway and the integration tool API: the Org's (no owner) or a Member's own | Until revoked |
| Pairing token | A one-time code that enrolls a desktop, which then holds a session | 30 minutes by default, 1–1440 |
| Connect ticket | A single-use string spent on one socket connect | 30 seconds, in memory |

Revoking a Member's credentials bumps their generation and revokes every session, API key and unused pairing token at once. It happens on an admin password reset and when the OIDC provider refuses the Member's stored refresh token. That recheck runs in the background on activity, at most once per interval. A provider outage changes nothing. A role change revokes nothing.

## Roles

| Role | May |
| --- | --- |
| member | Use the Agents visible to them, own their Threads, Machines, Projects, API keys and MCP servers, install skills, and read their own usage and activity |
| admin | Also manage Members, Teams, Integrations and their audiences, Model routes, the registry and Org prompts; manage every non-personal Agent; read the whole Org's usage and activity, and read any Member's Thread |

An admin's read of another Member's Thread is a read only. Every write to a Thread belongs to its owner. The last admin of an Org cannot be demoted or deleted.

## Agents

An Agent is visible to a Member when the Member owns it, when the Member is an admin (every Agent of the Org, personal ones included, for inspection and analytics), or when it is not personal and one of these holds: its visibility is `org`, or its visibility is `team` and one of the Member's Teams holds a grant. Seeing an Agent gives one of two levels:

| Level | Who | Allows |
| --- | --- | --- |
| manage | The owner, and admins on non-personal Agents | Edit, share, archive, delete and restore the Agent; create and run its Routines |
| use | Anyone else who sees it | Start Threads with it and spawn it |

A personal Agent is visible to its owner and to admins, and reaches no other Member. The chat composer offers each Member only their own personal Agent and the shared Agents they can use, never another Member's personal Agent. It cannot be made non-private, archived or deleted. An invisible Agent and a missing one answer the same 404.

Status limits use. Only an `active` Agent starts Runs. Archiving cancels its in-flight Runs. A `deleting` Agent keeps its Threads readable through a grace period (30 days by default), refuses new Threads and Turns with `agent_deleting`, and is purged afterwards. Restore works from `archived` or `deleting`.

## Threads

A Thread is readable by its Member and by admins, and writable only by its Member: Turns, renames, archive, delete, project binding, approval mode, approval answers, stop, steer and compact. An archived or deleted Thread refuses new Turns.

Child Threads follow the tree:

- A child Thread belongs to the Member whose Run spawned it.
- An Agent's tree tools reach only strict descendants of the calling Thread, and `send` needs the target open.
- The Member reads a child Thread and can cancel or delete it, along with its subtree. They cannot post into it.
- The root of a tree cannot be closed. Archiving or deleting a Thread closes its whole subtree first.

A Thread binds only to a Project its Member owns. The Thread's Machine follows from the Project.

## Machines and Projects

A Machine belongs to the Member who paired it. Only that Member's client can hold its socket slot. A second instance is displaced, never merged. Removing a Machine revokes the session it paired with and closes its socket. It is refused while Projects are bound to it. Binding does not require the Machine to be online: a tool call on an offline Machine fails as `machine offline`.

## Who a Run acts for

Every Run names the Member it acts for, and every check during the Run is made against that Member:

| Trigger | Acts for |
| --- | --- |
| message | The Member who sent it |
| routine, manual | The Routine's creator |
| delegation | The Member of the parent Run |

Every Run starts through one path, and that path refuses before creating a Run row when the Agent is deleting or inactive, or when the Member can no longer use the Agent. A Routine therefore stops working for a creator who lost access: its Occurrence fails at once with a Notice. A Run never writes into another Member's Thread. Searching and reading conversations reaches only the acting Member's Threads, even on a shared Agent.

## Tools

The Tools a Turn may call are the intersection of three things:

1. **The Agent's reach:** its built-in allowlist (all tools, or a selected list), which also decides the Trait tools, and its Integration list, each entry with a class ceiling (`read` < `write` < `admin`). With `selected` tools the list is explicit: an Integration reaches the Agent only when someone adds it. With `all` tools the list is derived at every read and has nothing to set: every enabled Integration that everyone who can use the Agent may reach, at the lowest ceiling the audience grants any of them. A personal Agent follows its owner's reach; a shared one never gives anyone more than their own, so it never warns.
2. **The Org's curation:** every Integration tool, built in or discovered from an MCP server, is on unless an admin turned it off.
3. **`admin`-class tools are admin-only,** whatever the Agent's ceiling says.

The Agent's list supersedes the caller's own access: everyone who can use the Agent reaches what it lists. Who may use the Agent is its visibility and grants.

### Integration audiences

An Integration has an audience: `org` (every member, up to an Org-wide ceiling), `team` (the granted Teams, each with its ceiling) or `admins`. A new Integration starts at `admins`. Ceilings in an audience are `read` or `write`; an admin always counts as `admin`.

The audience is checked when someone adds an Integration to an Agent or raises an entry's ceiling: the Member must manage the Agent and their own audience ceiling must be at least the entry's. Lowering or removing an entry needs only manage. Narrowing an audience removes no entry.

Where an Agent gives someone more of an Integration than its audience grants them, the Agent and the Integration's Access tab show a warning naming who (every member, a Team, or a Member granted the Agent by name, its owner included) and what. Nothing composes the two at call time.

A script calling the integration tool API has no Agent between it and the Integration, so the caller's own audience ceiling decides. An App's data function follows the same rule for whoever is viewing the App (see 004): sharing an App never lends its author's reach.

An Integration call acts as the Member's own mapped identity; overriding it is admin-only. An Integration that impersonates (Google Workspace) refuses a call without a Member identity. Integration secrets and MCP headers are encrypted at rest. They are decrypted only at call time and never appear in a snapshot, a prompt or a client.

## Exec policy and Approvals

A shell command (`bash`, `execute`, `agent_bash`) meets exec policy first. The command is split into its segments, and the strictest decision wins:

| Decision | Effect |
| --- | --- |
| forbidden | The call is refused. No Approval is offered |
| allow | The call runs without an Approval, unless the command uses shell features that turn it into `prompt` |
| prompt | The call goes to the Approval gate. An unmatched or unparsable command is `prompt` |

The Approval gate then decides, in this order:

1. **The Thread's approval mode,** if set: `ask` always asks, `full_access` never asks, and `approve_for_me` asks the Org's judge.
2. **Otherwise the Member's own policy** for that tool class.
3. **Otherwise the judge:** a model call with the Org's auto-approval policy prompt. An approving verdict runs the call silently. Any other result, including a judge failure, asks the Member.

On the sandbox Executor the Agent works unattended, so only commands go through the gate. Other tools run without a card. An Integration tool marked `always_ask` asks wherever an interactive gate exists. One marked `always_allow` never asks.

An Approval is answered once: the first answer wins under the Thread's lock. No answer within five minutes is a denial that tells the model not to retry. A stop ends a waiting Approval as aborted. An answer that arrives after its Turn ended is recorded as expired.

## Activity and usage

An admin reads the whole Org's usage, Runs, traces and conversations. A Member reads only their own. Raw model payloads are admin-only. An admin's personal Agent carries the same read as its `guild` tools; no other Agent has it, and no admin read is a write.

## Rejected

| Rejected | Reason |
| --- | --- |
| Admins writing into a Member's Thread | Reading is oversight; writing would put words in someone else's conversation |
| Admins seeing personal Agents | A personal Agent is the Member's private assistant, so admins get a 404 |
| Linking an OIDC login to a password account by email | An email match is not proof of ownership |
| Passing credentials to a child Run | A child acts for the same Member under its own Agent's allowlist. Nothing is handed down |
| Composing an Agent's and its caller's Integration access at call time | Two Members would get different tools from one Agent, and the Workspace carries data across them anyway. The warning makes the mismatch visible |
| Guild-side argument filters (repo, channel or pipeline allowlists) | Per vendor, easy to get wrong, and the raw `api` tool goes around them. The vendor token is the scope |
| Blocking a request on the IdP recheck | An IdP outage would become a Guild outage |
| A static allow that skips the gate for compound commands | Shell features can hide a second command, so they fall back to `prompt` |

## Known gaps

- An Agent's Workspace is shared by everyone who uses it, so what one caller's Turn fetches from an Integration and writes there, a later caller can read. The Agent is the unit of access; the audience warnings are the check.

- The schema still allows grant roles other than `user`; such a row grants nothing. Only team grants are written today.
- The `deleted` Agent status exists in the type, but a purge removes the row instead.
- Agent `resources` are recorded but not enforced. The sandbox runner applies its own limits.
