Lets agents read each member's own Google Workspace data: search their Gmail and open messages and attachments, see their upcoming calendar events, find Drive files, and look up people in the directory.

## What agents can do

- Search Gmail with Gmail search syntax and read one message: headers, text body, and its list of attachments.
- Download a Gmail attachment as a file in the chat.
- List upcoming events on the primary calendar, optionally within a time window.
- Search Drive files by name.
- List users in the Workspace directory.
- Call any Google API endpoint through the generic `api` tool. Its token carries only read-only scopes, so it cannot change anything.

## Before you start

- Google Workspace with a super admin who can set up domain-wide delegation.
- A Google Cloud project where you can create a service account key. Some orgs block key creation with the `iam.disableServiceAccountKeyCreation` policy.
- An admin account for the "Admin email" setting that can read the user directory.

## Set it up

1. In [Google Cloud → IAM & Admin → Service accounts](https://console.cloud.google.com/iam-admin/serviceaccounts), create a service account. Under **Keys → Add key → Create new key**, download a JSON key.
2. In the same project, enable the Gmail API, Google Calendar API, Google Drive API, and Admin SDK API.
3. In the [Admin console → Security → API controls → Domain-wide delegation](https://admin.google.com/ac/owl/domainwidedelegation), click **Add new**, enter the service account's client ID, and add these scopes:
   `https://www.googleapis.com/auth/gmail.readonly`, `https://www.googleapis.com/auth/calendar.readonly`, `https://www.googleapis.com/auth/drive.readonly`, `https://www.googleapis.com/auth/admin.directory.user.readonly`.
4. In Guild, install Google Workspace from the integrations page, enter the admin email, and paste the whole JSON key.
5. Click **Test connection**. Guild requests a token for the admin email, which proves the key and the delegation.
6. Enable the integration.

## Permissions and data

The integration acts as the calling member (`org_secret_impersonated`): Guild signs a token for the member's email with the one service account, so each chat reads only the mail, events, and files that member can already open. A call without a member identity is refused; the admin email is used only by **Test connection**. Every scope is read-only; nothing in Workspace is changed.

## Troubleshooting

- **"google token endpoint returned 401" or "400".** Delegation is missing or its scopes do not match the four above exactly, or the email is not a user in your domain. Delegation changes can take a while to apply.
- **"service_account_json is not valid json" or "missing private_key".** Paste the complete key file, not the client ID or a fragment.
- **A tool returns 403.** The API is not enabled in the Cloud project, or (for `directory_users`) the calling member is not an admin who can list users.
