Lets agents read and post in your Slack workspace: list channels and people, read a channel's recent messages, and post a message.

## What agents can do

- List the public and private channels the bot can see, with topics and whether the bot is a member.
- Read the message history of one channel. If the bot is not in a public channel, it joins it first and then reads.
- List workspace users with their names.
- Post a message to a channel. This writes.
- Call any Slack Web API method through the generic `api` tool. This can write, within the bot's scopes.

## Before you start

- Permission to create and install apps in the Slack workspace (or an admin to approve the install).
- A plan for private channels: the bot reads only the private channels it has been invited to.

## Set it up

1. At [api.slack.com/apps](https://api.slack.com/apps), choose **Create New App → From scratch** and pick the workspace.
2. Under **OAuth & Permissions → Bot Token Scopes**, add:
   - `channels:read`, `groups:read` for listing channels
   - `channels:history`, `groups:history` for reading history
   - `channels:join` for joining public channels before reading
   - `users:read` for listing users
   - `chat:write` for posting
3. Click **Install to Workspace**, approve, and copy the **Bot User OAuth Token** (`xoxb-…`).
4. Invite the bot to any private channel agents should read (`/invite @your-app`).
5. In Guild, install Slack from the integrations page and paste the bot token.
6. Click **Test connection** (it calls `auth.test`), then enable the integration.

## Permissions and data

All calls use the one shared bot token (`org_secret`): every member's agent reads and posts as the same bot, whoever asks. Agents can read every public channel and every private channel the bot is in. Reading a public channel the bot has not joined makes it join, which shows in that channel's member list. Messages agents post appear from the bot.

## Troubleshooting

- **"slack rejected the token (invalid_auth)".** The token is wrong or the app was uninstalled. Reinstall and copy the new token.
- **"slack api error: missing_scope".** A scope from the list is missing. Add it, reinstall the app, and paste the token again if it changed.
- **"slack api error: not_in_channel" or "channel_not_found" on a private channel.** Invite the bot to that channel.
- **Posting fails with "not_in_channel".** The bot posts only where it is a member; invite it, or add the `chat:write.public` scope for public channels.
