# Enterprise agent platforms: ownership and governance

## 1. Comparison

| Platform | Owner | Sharing | Identity | Data access | Audit |
|---|---|---|---|---|---|
| **Microsoft Copilot Studio** | One creator/owner. Collaborators edit but cannot delete. | Chat with users, security groups, or org. Co-authoring needs Environment Maker. | Entra ID. Tools can use user credentials. External connections bind to each user unless a service principal or environment connection is used. | Connectors, DLP, sensitivity labels. Transcript drill-down needs Bot Transcript Viewer. | Purview, Sentinel, Agent 365. |
| **Google Gemini Enterprise** | Exactly one owner. | Users, groups, WIF pools, or all users. Admin approval optional. 1,500-member IAM cap. | Agent has a SPIFFE identity. Connector data follows the caller's ACLs. | Connector ACLs apply. Knowledge uploads do **not**; any shared user can query them. | Traces, spans, usage audit logs. |
| **Salesforce Agentforce** | Builder or admin. Agent is metadata; no owner field. | Access by permission set or profile ("Agent Access"). Service agents get an auto-created Agent User. | Service agent runs as its Agent User for anonymous or verified users. Only an authenticated portal user makes it run as that user. | Agent User's CRUD, FLS, and sharing rules. Verified identity is not access. | Session tracing, Agent Analytics, Data 360. |
| **ServiceNow AI Agents** | Creator/admin (`sn_aia_admin`). | Invocation ACL: authenticated users, roles, or public. | **Dynamic User** inherits the caller's roles. **AI User** is a dedicated non-login `sys_user` with its own roles. | ACLs, role masking, user criteria against the run-as identity. | Agent traceability, AI Passport. |
| **AWS Bedrock AgentCore** | AWS account/developer; IAM, not end users. | Registry publishes agents and tools with review and approval. | Workload identity, JWT authorizer, OAuth credential providers, consent portal. | Scoped credentials per request. Policy intercepts every tool call. | OpenTelemetry to CloudWatch. |

## 2. Governance patterns

**Lifecycle.** States: draft, private, shared, enabled, suspended, deleted. Admins keep a kill switch. Microsoft has a Reassign API for orphaned agents. Google lets admins transfer ownership.

**Approval.** Google can require admin review before sharing. Microsoft can block publishing and apply DLP. AWS Registry has publish/review/approve.

**Offboarding.** Microsoft reassigns the agent; the old owner loses access and the new owner gets Environment Maker plus old transcripts. Google transfer demotes the old owner to `agentUser` and **disables schedules and triggers**. Salesforce and ServiceNow need manual reassignment.

**Quotas.** Copilot credits with caps. Google's 1,500-member IAM cap. Salesforce Flex credits. ServiceNow AI Agent consumption. AgentCore has no per-end-user quota.

## 3. What breaks in practice

1. **Orphaned agents.** The creator leaves. Grants and routines keep running, but nobody can approve changes. Microsoft built an API for this.
2. **Permission sprawl.** Agent users start blank, then teams add roles until the agent reaches most of the org. It never hesitates before using excess access.
3. **Per-user connection traps.** Copilot external connections bind to each user. The agent works for its maker and fails for others. The fix, a shared service principal, becomes a shared secret.
4. **Identity is not access.** A Salesforce customer can pass OTP verification and still be served by the Agent User's broad permissions.
5. **Hidden data paths.** Gemini enforces connector ACLs but not Knowledge upload ACLs. One upload can leak a document to every shared user.
6. **Transfer breaks automation.** Google disables schedules on transfer. Deactivating a Salesforce Agent User kills its agent.
7. **Shared service accounts.** One ServiceNow AI User with cross-scope roles serves many agents. Audit shows the account, not the agent.
8. **Coarse conversation visibility.** Transcripts are admin-only or owner-only.

## 4. Three models for Guild

**A. Org-owned agent with a service identity.** Org asset with a required owner, team steward, own principal, and explicit scopes. Admins transfer ownership. Pros: no orphans, predictable cron, clean attribution. Cons: no per-user data by default, constant grant management.

**B. Personal agent, shared like a document.** The creator owns it; the agent acts with the creator's identity. Others get use or edit rights. Pros: simple, data access matches the creator. Cons: leave risk, stale cron access, fragile connections, private data exposed by sharing.

**C. Hybrid: accountable owner plus dual run mode.** Org-owned with an owner and steward. Interactive runs default to the requester. Routines run as the agent with declared scopes. Roles: viewer, user, editor, owner. Pros: least privilege plus continuity. Cons: two modes confuse users.

## 5. Recommendation

Adopt **C**, with A as the storage model and B as the user experience.

- Store `owner_user_id`, `steward_team_id`, `visibility`, and `status` on every agent. The owner is accountable, not the source of access.
- Give the agent its own principal and scopes. Never inherit the owner's rights implicitly.
- Default interactive calls to requester context. Allow service mode only for a declared routine, with explicit scopes and approval.
- Share with roles: viewer (threads), user (invoke), editor (config), owner. Org-wide sharing is admin-only. Thread and file ACLs are separate from agent visibility.
- Routines declare scopes and audience. On owner deactivation, pause routines, notify the steward, and auto-transfer after 7 days.
- Record one audit row per invocation: requester, agent principal, scopes, tool calls, data IDs. Make the transcript readable only to its ACL.
- Add per-agent monthly budgets and an org cap. Require approval for write scopes and cross-team data.
- Ship an admin inventory with an "ownerless" filter, transfer, suspend, and kill actions.

This avoids the two dominant failures: orphaned agents and over-broad service identities.

## 6. Sources

- https://learn.microsoft.com/en-us/microsoft-copilot-studio/admin-share-bots
- https://learn.microsoft.com/en-us/microsoft-copilot-studio/admin-api-reassign-ownership-orphaned-agent
- https://learn.microsoft.com/en-us/microsoft-copilot-studio/security-and-governance
- https://learn.microsoft.com/en-us/microsoft-agent-365/overview
- https://docs.cloud.google.com/gemini/enterprise/docs/share-custom-agents
- https://docs.cloud.google.com/gemini/enterprise/docs/workflow-builder/share-chat-agent
- https://docs.cloud.google.com/gemini/enterprise/docs/agents-overview
- https://www.salesforceben.com/agentforce-permissions-explained-agent-users-access-and-security/
- https://trailhead.salesforce.com/content/learn/projects/quick-start-create-employee-agents-in-agentforce/grant-access-and-use-the-agents
- https://help.salesforce.com/s/articleView?id=xcloud.shr_einstein_audit_monitoring_agentforce_session_tracing.htm&language=en_US&type=5
- https://www.servicenow.com/community/servicenow-otto-for-creator/technical-article-securing-ai-agent-identities-in-now-assist/m-p/3580391
- https://servicenow.github.io/sdk/guides/building-ai-agents-guide
- https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/identity.html
- https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/what-is-bedrock-agentcore.html
