Lets agents answer product questions from one PostHog project: run HogQL over the events and persons, read the saved insights and dashboards, check the feature flags, and look up a person.

## What agents can do

- Run a HogQL query against the project and read the answer as a table.
- List the saved insights, filtered by name, and read one insight's kind, tags and query.
- List the dashboards and read the insights on one dashboard.
- List the feature flags with their key, active state and rollout.
- Find persons by email, distinct id or property value.
- Call any PostHog project API endpoint through the generic `api` tool. This can write, if the key has write scopes.

## Before you start

- A PostHog instance, cloud or self-hosted, and a project in it.
- The numeric project id of that project.
- A member of the project who can create personal API keys.

## Set it up

1. In PostHog open **Project settings** and copy the **Project ID**.
2. Open **Settings → Personal API keys → Create personal API key**. Choose **Project-scoped**, select the project, and grant the read scopes: `query:read`, `insight:read`, `dashboard:read`, `feature_flag:read`, `person:read`.
3. Copy the key (`phx_…`). PostHog shows it once.
4. In Guild, install PostHog from the integrations page.
5. Enter the PostHog URL, the project id, and the key.
6. Click **Test connection**. Guild reads `/api/projects/<id>/` with the key.
7. Enable the integration.

## Permissions and data

All calls use the one shared personal API key (`org_secret`), and every call names the configured project. Agents read what that key may read in that project, and nothing from another project. Events and persons hold user identifiers and property values, and whatever an agent reads enters the chat, so connect a project whose data every member may see. To cover several projects, install one PostHog integration per project.

## Troubleshooting

- **Test connection fails with 401.** The key is mistyped, revoked, or belongs to another instance. Create a new key and paste it again.
- **Test connection fails with 403.** The key is scoped to a different project or lacks `project:read`-class access. Recreate it as project-scoped for this project.
- **Test connection fails with 404.** The project id is wrong. It is the number in `/project/<id>` URLs, not the `phc_…` project token.
- **"posthog unreachable".** A self-hosted URL is wrong or not reachable from the Guild server. Enter the root address, without `/api`.
- **A query fails with "Unable to resolve field".** The HogQL names a column this project does not have. Run `select event, count() from events group by event` first to see the event names.
