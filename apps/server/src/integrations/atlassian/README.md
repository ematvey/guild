Lets agents look things up in Jira and Confluence Cloud: find issues with JQL, read an issue, search and read Confluence pages, and create new pages.

## What agents can do

- Search Jira issues with a JQL query and read one issue by key (summary, status, type, assignee, created date, link).
- Search Confluence with a CQL query and read one page as plain text.
- Create a Confluence page in a space from storage-format XHTML. This writes.
- Call any Jira or Confluence REST endpoint on the site through the generic `api` tool. This can write, so it is classed as a write tool.

## Before you start

- An Atlassian Cloud site (`https://<yourorg>.atlassian.net`). Jira Data Center and Confluence Server are not supported: the tools use the Cloud REST APIs.
- An Atlassian account for the integration, ideally a dedicated service user. Agents see and change exactly what this account can, so give it access to the projects and spaces they should reach.

## Set it up

1. Sign in to Atlassian as that account and open [Security → API tokens](https://id.atlassian.com/manage-profile/security/api-tokens).
2. Choose **Create API token** (the classic token, without scopes), name it, and copy the value. Scoped tokens only work through `api.atlassian.com` and fail against the site URL.
3. In Guild, install Atlassian from the integrations page.
4. Enter the site URL and the account email, and paste the API token.
5. Click **Test connection**. Guild calls `/rest/api/3/myself` with the email and token.
6. Enable the integration.

## Permissions and data

Every call uses HTTP basic auth with the one shared email and token (`org_secret`): all members' chats act as the same Atlassian account, whoever is asking. Agents can read any issue and page that account can browse, and create pages in any space where it has the "Add page" permission. The `api` tool reaches the rest of the Jira and Confluence APIs within the same permissions.

## Troubleshooting

- **Test connection fails with 401.** The email does not match the token's owner, or the token was revoked or is a scoped token. Create a new classic token as that account.
- **"atlassian requires the site setting" or the host is unreachable.** Check the site URL: it must be the `https://<yourorg>.atlassian.net` root, with no `/jira` or `/wiki` path.
- **"atlassian returned 400" on a search.** The JQL or CQL is invalid; the error excerpt names the problem.
- **A page or issue comes back 404, or page creation fails with 403.** The account lacks permission on that project or space. Grant it access in Jira or Confluence.
