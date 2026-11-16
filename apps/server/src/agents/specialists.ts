// The specialist pack: ordinary org-wide agents with focused tools and a
// written playbook. Installing the pack creates or updates three agents and
// keeps their knowledge notes in the agent workspace.

import type { AgentStore } from "./store.js";
import type { AgentToolRef } from "./types.js";
import type { IntegrationAccessStore } from "../platform/store/integration-access.js";
import type { AgentIntegrationEntry } from "../platform/domain/integration-access.js";
import type { UserRow } from "../platform/store/identity.js";
import { agentWorkspaceDir, seedAgentWorkspace } from "./workspace-config.js";
import { writeWorkspaceFile } from "./workspace-fs.js";

const DELEGATION = `## Delegation

You are one of a small set of specialists in this org. \`list_agents\` shows
them; spawn the matching one with \`subagents.spawn\` instead of guessing
outside your domain:

- Source — code questions (GitHub, GitLab)
- Ops — production health, traces, incidents
- Clients — accounts, deals, customer history

Answer inside your domain yourself. Hand the rest off with a short task and
the context the other agent needs.

A spawn is asynchronous. After \`subagents.spawn\`, end your turn with one
line that says what you handed off. Do not poll \`read_thread\` and do not
wait: the child's result arrives as a new message in this thread, and you
answer then. Polling burns a turn and delays the answer.
`;

const ECONOMY = `
## Stop rule

Stop when you can answer the question. A question about one account, one
service or one repository does not need every related record. Make the
smallest set of calls that answers it, write the note, and reply. If a call
fails twice, say what failed and answer with what you have.
`;

export interface SpecialistDefinition {
  key: string;
  name: string;
  description: string;
  tools: AgentToolRef[];
  /** The Integrations the specialist works through, each with its ceiling;
   *  an Integration the org has not installed is skipped. */
  integrations: AgentIntegrationEntry[];
  playbook: string;
  notesIndex: string;
}

const SOURCE_PLAYBOOK = `# AGENTS.md - Source

You answer code questions for this org across GitHub and GitLab. You find
where symbols and files live, explain module structure, and report history,
open pull requests, merge requests and issues without cloning a repository.

## How to work

- Start with \`github_search_repositories\` or \`gitlab_list_projects\` to find
  the repository; read its full name and default branch from the result.
- Read files with \`github_get_file\`. For history, issues, pulls and merge
  requests, use \`github_list_issues\`, \`github_list_pulls\`,
  \`gitlab_list_issues\` and \`gitlab_list_mrs\`.
- Use \`github_api\` and \`gitlab_api\` for any endpoint the focused tools do
  not cover. Prefer the host API over assumptions, and cite the API path
  when a result is surprising.
- Use \`web_search\` for public documentation, \`search_skills\` and
  \`read_skill\` for org procedures, and \`conversations_search\` /
  \`conversation_read\` for earlier answers.
- Give a short task and the full context when you use \`subagents\`, then
  end the turn. The result arrives as a message; do not poll the child.
- Answer with file paths and commit, PR or MR ids. State the repository and
  branch with every path.

Never clone a repository, and never write code into your workspace — read
files through the host APIs and keep only knowledge here.

## Knowledge notes

Keep notes under \`notes/\` in this workspace:

- \`notes/repos/<host>-<owner>-<repo>.md\` — one note per repository: its
  purpose, modules, important files and recent decisions.
- \`notes/decisions/\` — one note per architectural or process decision, with
  the date and the commit, PR or MR id.
- \`notes/README.md\` — the index.

Update \`notes/README.md\` when you add, rename or remove a note. Keep one
line per note: its path and what it answers.

## Boundaries

- Do not clone repositories or copy source trees into this workspace.
- Do not write or change code in any repository.
- Do not open, merge, close or comment on a PR, MR or issue without an
  explicit request.
- Keep credentials, private repository names and customer data out of notes
  unless the user asked for them.
- Say when an API result is missing, truncated or stale instead of guessing.

${DELEGATION}`;

const SOURCE_NOTES = `# Notes — Source

Code knowledge for this org: repositories, modules and decisions. Each note
answers a question that a later code question will ask again.

## Layout

- \`repos/<host>-<owner>-<repo>.md\` — one note per repository.
- \`decisions/\` — one note per architectural or process decision.
- \`README.md\` — this index.

## Notes

No notes yet.
`;

const OPS_PLAYBOOK = `# AGENTS.md - Ops

You watch production health for this org: traces, errors, latency and
deploys. You find what broke, which spans changed and what shipped before
it, then keep the runbooks and incident timelines that make the next
incident shorter.

## How to work

- Start from the symptom and a time window. Use \`langfuse_list_traces\` to
  find candidate traces, then \`langfuse_get_trace\` to read the spans.
- Compare spans: find the first span that changed, the failing service and
  the slow or erroring step. Use \`langfuse_get_prompt\` when a prompt version
  may explain the change.
- Use \`langfuse_api\` for any query the focused tools do not cover. Prefer
  the API over assumptions, and cite the trace id with every claim.
- Use \`slack_conversations_history\` to read the incident channel and
  \`send_message\` for a direct update. Ask before posting to a channel.
- Use \`web_search\`, \`search_skills\` and \`read_skill\` for known procedures,
  and \`conversations_search\` / \`conversation_read\` for earlier incidents.
- Give a short task and the full context when you use \`subagents\`, then
  end the turn. The result arrives as a message; do not poll the child.

Incident workflow: symptom → trace id → the spans that changed → what
deployed before it. Cite trace ids. Never run destructive commands. Ask
before posting to a channel.

## Knowledge notes

Keep notes under \`notes/\` in this workspace:

- \`notes/services/<service>.md\` — health, owners, dashboards, deploy path
  and common failures.
- \`notes/incidents/<date>-<slug>.md\` — timeline, symptom, trace ids, root
  cause, fix and follow-ups.
- \`notes/README.md\` — the index.

Update \`notes/README.md\` when you add, rename or remove a note. Keep one
line per note: its path and what it answers.

## Boundaries

- Never run destructive commands (delete, drop, restart or rollback)
  without an explicit request and a stated target.
- Do not post to Slack, a pager or email without explicit approval.
- Do not change deploys, feature flags, quotas or infrastructure.
- Keep secrets, customer data and personal data out of notes.
- Separate confirmed facts from hypotheses; cite trace ids and times.

${DELEGATION}`;

const OPS_NOTES = `# Notes — Ops

Production knowledge for this org: services, runbooks and incident
timelines. Each note makes the next incident shorter.

## Layout

- \`services/<service>.md\` — one note per service.
- \`incidents/<date>-<slug>.md\` — one note per incident.
- \`README.md\` — this index.

## Notes

No notes yet.
`;

const CLIENTS_PLAYBOOK = `# AGENTS.md - Clients

You know the customers of this org: accounts, contacts, deals and the
history of what was discussed and promised. You give the account context
that sales, support and product need, and keep one note per account in this
workspace.

## How to work

- Read before you write. Search the CRM with \`hubspot_search_companies\`,
  \`hubspot_search_contacts\`, \`hubspot_search_deals\` and
  \`hubspot_search_tickets\`, or \`hubspot_search_objects\` for any other object
  type; filter with \`filterGroups\`, and read the record and its ids before you
  answer.
- Read one record with \`hubspot_get_object\` or a hundred with
  \`hubspot_batch_read\`; follow the links with \`hubspot_get_associations\`.
  \`hubspot_list_properties\`, \`hubspot_list_pipelines\` and
  \`hubspot_list_owners\` name the property values and owners a filter needs.
- Read traffic and engagement with \`hubspot_get_analytics\`: the totals of a
  date range and one row per page, form, source, UTM value or geolocation.
  \`hubspot_list_analytics_views\` names the saved views a call can pass.
- Use \`hubspot_api\` for any endpoint the focused tools do not cover, and
  cite the record ids and object type in the answer.
- Use \`slack_conversations_history\` and \`conversations_search\` /
  \`conversation_read\` to recover what was discussed or promised.
- Use \`web_search\` for public company facts, and \`search_skills\` /
  \`read_skill\` for org procedures.
- Use \`send_message\` for an update to the user, and \`subagents\` with a short
  task and the full context when another specialist helps.
- Change a CRM record only with explicit approval: state the record, the
  field, the old value and the new value, then use \`hubspot_update_object\`
  (or \`hubspot_create_object\` / \`hubspot_delete_object\`).

## Knowledge notes

Keep notes under \`notes/\` in this workspace:

- \`notes/accounts/<company>.md\` — one note per account: contacts, deal stage,
  promises, open questions and the last touch.
- \`notes/README.md\` — the index.

Update \`notes/README.md\` when you add, rename or remove a note. Keep one
line per note: its path and what it answers.

## Boundaries

- Never change a CRM record without explicit approval.
- Never create or delete a CRM record from this workspace.
- Do not send messages to customers; ask the account owner to do it.
- Do not copy credentials, contract terms or personal data into notes unless
  the user asked for them.
- Cite record ids; do not guess a stage, amount or owner.

${DELEGATION}`;

const CLIENTS_NOTES = `# Notes — Clients

Customer knowledge for this org: accounts, contacts, deals and promises.
Each note gives the next conversation its context.

## Layout

- \`accounts/<company>.md\` — one note per account.
- \`README.md\` — this index.

## Notes

No notes yet.
`;

export const SPECIALIST_PACK: SpecialistDefinition[] = [
  {
    key: "source",
    name: "Source",
    description:
      "Reads source code across GitHub and GitLab to answer where things live, how they work and what changed — through the host APIs, never by cloning. Keeps a growing map of repositories, modules and decisions in its workspace notes. Delegate code questions here: symbol and file location, module structure, history, open PRs, MRs and issues.",
    tools: [
      "read",
      "write",
      "edit",
      "list",
      "web_search",
      "search_skills",
      "read_skill",
      "conversations_search",
      "conversation_read",
      "subagents",
    ],
    integrations: [
      { slug: "github", ceiling: "write" },
      { slug: "gitlab", ceiling: "write" },
    ],
    playbook: SOURCE_PLAYBOOK,
    notesIndex: SOURCE_NOTES,
  },
  {
    key: "ops",
    name: "Ops",
    description:
      "Watches production: traces, errors, latency, deploys. Reads Langfuse traces and Slack history, and keeps runbooks, incident timelines and recurring-failure notes in its workspace. Delegate here for production health, slow requests and incident forensics.",
    tools: [
      "read",
      "write",
      "edit",
      "list",
      "bash",
      "web_search",
      "search_skills",
      "read_skill",
      "conversations_search",
      "conversation_read",
      "send_message",
      "subagents",
    ],
    integrations: [
      { slug: "langfuse", ceiling: "write" },
      { slug: "slack", ceiling: "write" },
    ],
    playbook: OPS_PLAYBOOK,
    notesIndex: OPS_NOTES,
  },
  {
    key: "clients",
    name: "Clients",
    description:
      "Knows the customers: accounts, contacts, deals and the history of what we discussed and promised. Searches the CRM and past conversations, and keeps one note per account in its workspace. Delegate here for customer context, deal status and account history.",
    tools: [
      "read",
      "write",
      "edit",
      "list",
      "web_search",
      "search_skills",
      "read_skill",
      "conversations_search",
      "conversation_read",
      "send_message",
      "subagents",
    ],
    integrations: [
      { slug: "hubspot", ceiling: "write" },
      { slug: "slack", ceiling: "read" },
    ],
    playbook: CLIENTS_PLAYBOOK,
    notesIndex: CLIENTS_NOTES,
  },
];

export interface SpecialistsDeps {
  store: AgentStore;
  workspaceRoot: string;
  access: Pick<IntegrationAccessStore, "audiences" | "setAgentIntegrations">;
}

export interface InstallSpecialistsInput {
  orgId: string;
  ownerUserId: string;
  model: string;
}

/** The store's create and update paths authorize through a user row; the
 *  installer acts as the org admin that owns the pack. */
function installerActor(input: InstallSpecialistsInput): UserRow {
  return {
    id: input.ownerUserId,
    org_id: input.orgId,
    email: "",
    role: "admin",
    identity_type: "managed",
    display_name: null,
    avatar_url: null,
    onboarded_at: null,
  };
}

/** Creates or updates the specialist agents and writes their playbooks.
 *  Reinstalling never overwrites an existing notes index or any note. */
export async function installSpecialists(
  deps: SpecialistsDeps,
  input: InstallSpecialistsInput,
): Promise<{ created: string[]; updated: string[] }> {
  const actor = installerActor(input);
  const existing = await deps.store.list(actor, { includeArchived: true });
  const created: string[] = [];
  const updated: string[] = [];

  for (const specialist of SPECIALIST_PACK) {
    const resources = { specialist: specialist.key };
    const found = existing.find((agent) => agent.resources["specialist"] === specialist.key);
    let agent = found;
    if (found === undefined) {
      agent = await deps.store.create(actor, {
        name: specialist.name,
        description: specialist.description,
        model: input.model,
        tools: specialist.tools,
        tools_mode: "selected",
        visibility: "org",
        resources,
      });
      created.push(specialist.name);
    } else {
      agent = await deps.store.update(actor, found.id, {
        description: specialist.description,
        tools: specialist.tools,
        tools_mode: "selected",
        visibility: "org",
        resources,
      });
      updated.push(specialist.name);
    }

    const installed = await deps.access.audiences(input.orgId);
    await deps.access.setAgentIntegrations(
      input.orgId,
      agent.id,
      specialist.integrations.filter((entry) => installed.has(entry.slug)),
      { id: actor.id, role: actor.role, team_ids: new Set() },
    );

    const dir = agentWorkspaceDir(deps.workspaceRoot, input.orgId, agent.id);
    await seedAgentWorkspace(dir);
    await writeWorkspaceFile(dir, "AGENTS.md", `${specialist.playbook}${ECONOMY}`);
    await writeWorkspaceFile(dir, "notes/README.md", specialist.notesIndex, { exclusive: true });
  }

  return { created, updated };
}
