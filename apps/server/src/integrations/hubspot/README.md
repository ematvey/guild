Lets agents investigate HubSpot CRM, marketing emails, audiences, campaigns and workflows, read Analytics, and change CRM records within their granted scopes.

## What agents can do

- Search contacts (name and email), companies (name and domain), and deals (name and amount) by free text.
- Read the legacy Analytics API: the totals of a date range and one row per page, form, social asset, source, UTM value, geolocation or session. `list_analytics_views` names the saved views a call can pass as `view_id`.
- Update the properties of one deal by id, such as its stage or amount. This writes.
- Read emails with `list_marketing_emails` and `get_marketing_email`. Email details preserve `createdById`, `publishedById`, `publishedByEmail`, `publishedByName`, visible sender, audience configuration, content and statistics. A list creator is not proof of who sent an email.
- Read actual delivery and engagement history with `get_email_events`. Its `campaignId` is an email's `primaryEmailCampaignId`, not a content id or a marketing campaign UUID. Filter by recipient, event type and Unix-millisecond time bounds.
- Inspect audience filters and ownership with `search_lists` and `get_list`, current members with `get_list_members`, and a record's current lists with `get_list_memberships` (`object_type_id: "0-1"` for contacts). Current membership does not establish send-time audience.
- Read campaign details and assets with `list_campaigns`, `get_campaign`, and `list_campaign_assets`.
- Read v4 automation definitions with `list_workflows` and `get_workflow`. Classic v3 workflows remain accessible through `api`; an empty v4 result does not prove no automation exists.
- Ask `get_object` for `propertiesWithHistory: ["region"]` to inspect previous values and sources.
- Diagnose effective access with `check_capabilities`: CRM, emails, events, lists, campaigns and workflows each get a separate result. A blocked area does not hide successful areas.
- Marketing tools return complete JSON, including vendor pagination fields. Follow `paging.next.after`, list search `offset` while `hasMore`, or email event `offset` while `hasMore`; one page is not a complete count. Large results use Guild's tool artifacts, without cutting JSON. Batch CRM reads preserve all requested properties.
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
5. For marketing investigations add `content` (an accepted scope for marketing emails and email events), `marketing.campaigns.read`, `crm.lists.read`, and `automation` for workflows. Email endpoints also accept granular scopes where the app offers them; an API error listing alternatives does not require all of them. Save the app scopes.
6. Click **Test connection**. Guild lists one contact, so the token needs the contacts read scope. This only establishes CRM connectivity. Run `hubspot_check_capabilities` from a chat to diagnose each area independently.
7. Enable the integration.

## Permissions and data

All calls use the one shared private-app token (`org_secret`), so every member's agent works with the same CRM data and the same scopes, whoever asks. Deal updates show in HubSpot as made by the private app.

## Troubleshooting

- **"hubspot returned 401".** The token is wrong or was rotated. Copy the current token from the private app.
- **"hubspot returned 403".** The app lacks a scope for that object or action, such as `crm.objects.deals.write` for updating a deal or `business-intelligence` for an analytics report. Add the scope to the private app and save.
- **"hubspot returned 404" on a deal update.** The deal id is wrong. Use the numeric id from a deal search.
- **"hubspot returned 400" on a deal update.** A property name or value is invalid, such as an unknown deal stage id.
