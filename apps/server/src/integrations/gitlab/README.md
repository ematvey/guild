Lets agents work with GitLab: list your projects, list issues and merge requests, and open issues. It works with gitlab.com and self-managed GitLab.

## What agents can do

- List the projects the token's user is a member of, most recently active first, with an optional name filter.
- List the issues of one project by state.
- List the merge requests of one project with their branches and authors.
- Open a new issue in a project. This writes.
- Call any GitLab REST endpoint through the generic `api` tool. This can write, within the token's scope and role.

Projects are named by numeric id or by full path, such as `group/project`.

## Before you start

- A GitLab user with at least the Reporter role on the projects agents should read. A dedicated bot user keeps access separate from a person's.
- A personal, group, or project access token. A project token sees only its own project.
- For self-managed GitLab, its address.

## Set it up

1. Create a token under [User settings → Access tokens](https://gitlab.com/-/user_settings/personal_access_tokens) (or a group or project's **Settings → Access tokens**).
2. Select the `api` scope. Choose `read_api` instead if agents should not open issues or change anything.
3. Copy the token (`glpat-…`).
4. In Guild, install GitLab from the integrations page and paste the token. For self-managed GitLab, enter its address as the API URL; Guild adds `/api/v4` to a bare host.
5. Click **Test connection** (it calls `/user`), then enable the integration.

## Permissions and data

All calls use the one shared token (`org_secret`), sent as the `PRIVATE-TOKEN` header. Every member's agent sees the same projects, and issues opened by agents show the token's user as author.

## Troubleshooting

- **"gitlab auth failed (401)".** The token is wrong, expired, or revoked.
- **"gitlab returned 403" when opening an issue.** The token has only `read_api`, or its user lacks a role that can create issues there.
- **"gitlab: not found (project or resource)".** The project path or id is wrong, or the token's user cannot see the project.
- **Self-managed GitLab returns HTML or 404 everywhere.** If GitLab lives under a path (`https://example.com/gitlab`), enter the full API root, `https://example.com/gitlab/api/v4`.
