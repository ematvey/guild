Lets agents read your Langfuse LLM traces and prompts, so they can answer "why did the agent do that" from the model calls, token counts, and tool spans of a run.

## What agents can do

- List recent traces with id, name, and timestamp.
- Read one trace in full by id.
- Fetch a prompt by name, latest or a specific version.
- Call any Langfuse public API endpoint through the generic `api` tool. This can write, such as creating prompts or scores.

## Before you start

- A Langfuse project, on Langfuse Cloud or self-hosted, and a member role there that can create API keys.
- Your Langfuse address: `https://cloud.langfuse.com` (EU), `https://us.cloud.langfuse.com` (US), or your self-hosted URL.

## Set it up

1. In Langfuse, open the project and go to **Settings → API Keys → Create new API keys**.
2. Copy the public key (`pk-lf-…`) and the secret key (`sk-lf-…`). The secret key is shown only once.
3. In Guild, install Langfuse from the integrations page.
4. Enter the Langfuse URL if it is not the EU cloud, and paste both keys.
5. Click **Test connection**. Guild calls `/api/public/projects` with the key pair.
6. Enable the integration.

## Permissions and data

All calls use the one shared key pair (`org_secret`) with HTTP basic auth. A key pair belongs to one project: agents see that project's traces and prompts, and nothing from other projects. Traces can hold full prompts, model outputs, and user inputs, and whatever an agent reads enters the chat, so connect a project whose data every member may see. To cover several projects, install one Langfuse integration per project.

## Troubleshooting

- **Test connection fails with 401.** The keys are swapped, mistyped, or from another Langfuse region or instance. The URL must match where the project lives.
- **"langfuse unreachable".** A self-hosted URL is wrong or not reachable from the Guild server. Enter the root address, without `/api`.
- **A trace or prompt returns 404.** The id or name belongs to a different project than the key pair, or the prompt version does not exist.
