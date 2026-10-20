# Workspace bots/agents: ownership and permissions

## 1. Ownership models compared

| System | Agent owner | Who can use | Identity model | Conversation visibility |
|---|---|---|---|---|
| **Slack** | Workspace owns the installation; developer owns the app; installer owns the OAuth grant. | Any member installs by default; owners can require approval. After install, all members can use it. | Bot user with bot token (`xoxb-`), separate from humans. Optional user token acts as the installer. | User–bot DMs are private. Channel messages are visible to channel members. |
| **GitHub Apps** | App owned by a user or org; installation belongs to the org/repo. | Org owners install; access by installation permissions and selected repos. | Installation token acts as the app, not a user; expires in 1 hour. Optional user token inherits that user's access. | No chat. Actions appear in issue/PR timelines attributed to app or user. |
| **GitHub Copilot coding agent** | Platform provides the agent; the session belongs to the user who started it. | Users with repo access start sessions; org policy controls availability. | Commits authored by Copilot, initiator as co-author. Repo permissions and branch protections still apply. | Cloud sessions are shared by default with repo access. Local sessions are unshared. |
| **Linear** | Workspace admin installs; app user is unique per workspace. | Any user with access to selected teams can mention or assign it. Admins can revoke team access. | `actor=app` installation, not user delegation. `app:assignable` and `app:mentionable` scopes. Assignment sets a *delegate*, not an assignee. | Issue comments and activity are visible to issue viewers. Agent chat history is per-user. |
| **Notion** | Connection installed by a member, who becomes connection owner. | Members add connections; Enterprise owners restrict the approved list and revoke users. | OAuth connection acting with the installer's authorization. Access is granted page by page. | No chat. Access is page-level; owners see who installed a connection. |

## 2. Permission and lifecycle patterns

**Install.** Slack and Notion default to member self-install, with an admin approval switch. GitHub Apps and Linear agents require an owner/admin to install at org or workspace scope. Linear asks the installer to choose teams.

**Scope grant.** Slack splits bot scopes from user scopes; bot scopes are the norm. GitHub splits app permissions from user authorization. Linear exposes optional capabilities as scopes. Notion grants page access separately from workspace installation.

**Revoke.** Slack owners remove an app or revoke one authorization. GitHub org owners suspend or delete an installation. Linear admins change team access at any time; the agent gets a `PermissionChange` webhook. Notion Enterprise owners revoke one user, disconnect all users, or remove a connection from the approved list.

**Offboarding.** Slack bot tokens are not tied to a user; the app stays installed when the installer is deactivated. GitHub installations survive the installer leaving because the org owns them. Linear app users are workspace-scoped. Notion connections are tied to the authorizing user, so losing that user can break the connection unless an owner re-authorizes.

**Audit.** GitHub attributes installation-token actions to the app and user-token actions to the user. Linear exposes agent user pages and frozen agent-activity records. Slack Enterprise Grid audit logs record app installs and removals. Notion shows which members installed each connection.

## 3. Agent-to-agent communication

None of the four has a first-class agent-to-agent protocol.

- **Slack:** bots post in shared channels and receive each other's message events. Simplest A2A bus, but needs loop guards and bot-message filters.
- **Linear:** app users can be mentioned and assigned like humans. An agent with mention rights can hand off to another agent. No dedicated delegation primitive, so loops are a risk.
- **GitHub:** apps trigger each other through webhooks, issues, and PRs. Copilot can be assigned an issue by another app.
- **Notion:** no agent runtime; automations and webhooks only.

## 4. Three models Guild could adopt

**A. Org-owned service identity (GitHub App / Linear).** Workspace owns the agent; an admin installs it with team scopes. It persists through turnover. Conversations are shared in threads by default.
*Pros:* stable, auditable, no orphaned agents. *Cons:* admin bottleneck; weak personal context.

**B. User-owned delegated agent (Slack user token / Notion).** Creator owns the agent; it acts with the creator's permissions. DMs are private.
*Pros:* simple, fast self-serve, good for personal data. *Cons:* breaks on offboarding, leaks when the creator shares, weak governance.

**C. Hybrid: org-owned identity plus per-user delegation grants.** Agent is a workspace member owned by the org, with team-scoped base permissions. A user links their account to grant delegated access to private data. Conversations are private by default; posting into a shared thread publishes them.
*Pros:* survives offboarding, supports shared and private work, clear audit split. *Cons:* two credential paths to secure; more UI.

## 5. Recommendation

Adopt **C**, with Linear as the template:

1. Agent is an org-owned member with a stable ID, installed by an owner/admin and scoped to teams or projects.
2. Base token is a service identity. User data access requires an explicit per-user grant, revocable independently.
3. Conversations are private by default; a thread becomes shared when moved into a channel or project. Activity is append-only and auditable.
4. Agent-to-agent handoff uses explicit mentions in shared threads, with hop limits and loop detection.
5. Offboarding revokes delegation grants but never deletes the agent. Ownership sits with the workspace.

Guild gets persistent agents that survive turnover while personal data stays behind a revocable grant.

## 6. Sources

Slack: [scopes](https://docs.slack.dev/reference/scopes/), [tokens](https://docs.slack.dev/authentication/tokens), [OAuth install](https://docs.slack.dev/authentication/installing-with-oauth), [app approval](https://slack.com/help/articles/222386767-Manage-app-approval-for-your-workspace), [add apps](https://slack.com/help/articles/202035138-Add-apps-to-your-Slack-workspace), [remove apps](https://slack.com/help/articles/360003125231-Remove-apps-and-custom-integrations-from-your-workspace), [permissions](https://slack.com/help/articles/1500009181142-Manage-app-settings-and-permissions).

GitHub: [installation auth](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation), [on behalf of a user](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-with-a-github-app-on-behalf-of-a-user), [install app](https://docs.github.com/en/apps/using-github-apps/installing-your-own-github-app), [Copilot on GitHub](https://docs.github.com/en/copilot/concepts/copilot-surfaces/copilot-on-github), [manage agent sessions](https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/manage-and-track-agents).

Linear: [AI agents](https://linear.app/docs/agents-in-linear), [Linear Agent](https://linear.app/docs/linear-agent), [coding sessions](https://linear.app/docs/coding-sessions), [developer agents](https://linear.app/developers/agents), [best practices](https://linear.app/developers/agent-best-practices).

Notion: [connections](https://www.notion.com/help/add-and-manage-connections-with-the-api), [Enterprise connection settings](https://www.notion.com/help/enterprise-connection-settings).
