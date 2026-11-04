Lets agents work with your GitHub repositories: find repositories, list issues and pull requests, read files, and open issues.

## What agents can do

- Search repositories (name, link, language, stars).
- List the issues of a repository, without pull requests, by state.
- List the pull requests of a repository with their branches and authors.
- Read one text file from a repository at a branch, tag, or commit.
- Open a new issue with a title, body, and labels. This writes.
- Call any GitHub REST endpoint through the generic `api` tool. This can write, within the token's permissions.

## Before you start

- A GitHub account that can reach the repositories agents should see. A dedicated machine user keeps the access separate from a person's.
- A fine-grained personal access token (recommended) or a classic token. Your organization may require approval for fine-grained tokens.
- For GitHub Enterprise Server, its API address, `https://<your-host>/api/v3`.

## Set it up

1. Open [Settings → Developer settings → Fine-grained tokens → Generate new token](https://github.com/settings/personal-access-tokens/new).
2. Set **Resource owner** to your organization and choose the repositories.
3. Under repository permissions grant **Contents: Read**, **Issues: Read and write**, and **Pull requests: Read**. Metadata: Read is added automatically. Grant more only if agents should use the `api` tool for other changes.
4. Generate the token and copy it. If the org requires approval, an org owner approves it under the org's personal access token settings.
5. In Guild, install GitHub from the integrations page, paste the token, and change the API URL only for GitHub Enterprise.
6. Click **Test connection** (it calls `/user`), then enable the integration.

## Permissions and data

All calls use the one shared token (`org_secret`), so every member's agent sees and changes the same repositories, whoever asks. Issues opened by agents show the token owner as author. File reads refuse `..` path segments, so a request cannot step outside the named repository.

## Troubleshooting

- **"github auth failed (401)".** The token is wrong, expired, or revoked.
- **"github auth failed (403)".** The token lacks a permission for that call (for example Issues: Read and write for opening an issue), the org has not approved it, or a rate limit hit.
- **"github: not found".** The repository is outside the token's selected repositories, or the owner, name, or path is wrong. GitHub answers 404 for private repositories a token cannot see.
- **"github file too large for the contents API".** The file is over the size the contents API returns inline; read it another way.
