Lets agents look up your HubSpot CRM: find contacts, companies, and deals, read the legacy Analytics API, and update a deal when a conversation changes it.

## What agents can do

- Search contacts (name and email), companies (name and domain), and deals (name and amount) by free text.
- Read the legacy Analytics API: the totals of a date range and one row per page, form, social asset, source, UTM value, geolocation or session. `list_analytics_views` names the saved views a call can pass as `view_id`.
- Update the properties of one deal by id, such as its stage or amount. This writes.
- Call any HubSpot API endpoint through the generic `api` tool. This can write, within the token's scopes.

## Analytics reports

One tool, `get_analytics`, covers the three report families of the legacy Analytics API:

- Hosted content: `landing-pages`, `standard-pages`, `blog-posts`, `listing-pages`, `knowledge-articles`.
- Session breakdowns: `totals`, `sessions`, `sources`, `geolocation`, `utm-campaigns`, `utm-contents`, `utm-mediums`, `utm-sources`, `utm-terms`.
- Object engagement: `pages`, `forms`, `event-completions`, `social-assists`.

Each row carries the metrics HubSpot holds for that family: `rawViews`, `visits`, `visitors`, `leads`, `contacts`, `subscribers`, `submissions`, `bounceRate`, `timePerSession`, `pageviewsPerSession` and the rate fields. The call pages with `offset`.

The Analytics API is the legacy one. It reads traffic and engagement totals. It does not read report definitions, dashboards or deal pipelines; a pipeline question is a CRM search, not an analytics call.

## Before you start

- A HubSpot account and a super admin, who is the only role that can create private apps.
- A decision on which objects agents may touch: the private app's scopes are the limit.

## Set it up

1. In HubSpot, open **Settings → Integrations → Private Apps → Create a private app**. In newer accounts this lives under **Development → Legacy apps → Create → Private**. See [private apps](https://developers.hubspot.com/docs/api/private-apps).
2. On the **Scopes** tab, grant `crm.objects.contacts.read`, `crm.objects.companies.read`, `crm.objects.deals.read`, and `crm.objects.deals.write`. Add `business-intelligence` to read the legacy Analytics API. Add other scopes only if agents should reach more through the `api` tool.
3. Create the app and copy its access token (`pat-…`).
4. In Guild, install HubSpot from the integrations page and paste the token.
5. Click **Test connection**. Guild lists one contact, so the token needs the contacts read scope.
6. Enable the integration.

## Permissions and data

All calls use the one shared private-app token (`org_secret`), so every member's agent works with the same CRM data and the same scopes, whoever asks. Deal updates show in HubSpot as made by the private app.

## Troubleshooting

- **"hubspot returned 401".** The token is wrong or was rotated. Copy the current token from the private app.
- **"hubspot returned 403".** The app lacks a scope for that object or action, such as `crm.objects.deals.write` for updating a deal or `business-intelligence` for an analytics report. Add the scope to the private app and save.
- **"hubspot returned 404" on a deal update.** The deal id is wrong. Use the numeric id from a deal search.
- **"hubspot returned 400" on a deal update.** A property name or value is invalid, such as an unknown deal stage id.
