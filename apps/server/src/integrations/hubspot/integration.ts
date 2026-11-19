import { hubspotBaseUrl, secret } from "../shared.js";
import { PROBE_TIMEOUT_MS, probe } from "@guild/integration-sdk";
import { fetchTimeout } from "../shared.js";
import type { JsonObject } from "../shared.js";
import type { IntegrationPlugin } from "@guild/integration-sdk";
import { hubspotExecute, ANALYTICS_PERIODS, ANALYTICS_REPORTS } from "./execute.js";
import { apiTool } from "@guild/integration-sdk";

/** One CRM search filter. Values are strings: HubSpot compares property
 *  values as text, and `values`/`highValue` cover the multi-value and range
 *  operators. */
const SEARCH_FILTER = {
  type: "object",
  properties: {
    propertyName: { type: "string", description: "Internal property name, e.g. dealstage, end_date, hs_object_id" },
    operator: {
      type: "string",
      enum: [
        "EQ",
        "NEQ",
        "LT",
        "LTE",
        "GT",
        "GTE",
        "BETWEEN",
        "IN",
        "NOT_IN",
        "HAS_PROPERTY",
        "NOT_HAS_PROPERTY",
        "CONTAINS_TOKEN",
        "NOT_CONTAINS_TOKEN",
      ],
    },
    value: { type: "string", description: "The value to compare; BETWEEN takes the low end" },
    values: { type: "array", items: { type: "string" }, description: "IN and NOT_IN" },
    highValue: { type: "string", description: "BETWEEN takes the high end here" },
  },
  required: ["propertyName", "operator"],
};

/** The arguments every search tool shares: free text, filters, the
 *  properties to return, sorting and one page at a time. */
const SEARCH_PARAMETERS = {
  type: "object",
  properties: {
    query: { type: "string", description: "Free text over the object's default properties; omit it to filter only" },
    filterGroups: {
      type: "array",
      description: "Filters; a record matches when any group matches, and every filter in a group matches",
      items: { type: "object", properties: { filters: { type: "array", items: SEARCH_FILTER } } },
    },
    properties: {
      type: "array",
      items: { type: "string" },
      description: "Properties to return; defaults to a short display set for the known object types",
    },
    sorts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          propertyName: { type: "string" },
          direction: { type: "string", enum: ["ASCENDING", "DESCENDING"] },
        },
        required: ["propertyName"],
      },
    },
    limit: { type: "number", description: "1-100 records, default 10" },
    after: { type: "string", description: "The `after` cursor a previous call returned" },
  },
};

const searchTool = (name: string, description: string) => ({
  name,
  class: "read" as const,
  description: `${description} Reads only: the CRM v3 search API cannot change a record.`,
  parameters: SEARCH_PARAMETERS,
});

const OBJECT_TYPE = (description: string) => ({ type: "string", description });

/** The object type a call names, for the tools that reach every object. */
const objectTypeParameter = (description: string) => ({
  type: "object",
  properties: { object_type: OBJECT_TYPE(description) },
  required: ["object_type"],
});

const MARKETING_ID = { type: "string", minLength: 1, description: "HubSpot resource id" };
const MARKETING_PAGE = {
  limit: { type: "integer", minimum: 1, maximum: 100, default: 25 },
  after: { type: "string", description: "Opaque paging.next.after from the previous page" },
};

const plugin: IntegrationPlugin = {
  manifest: {
    name: "hubspot",
    title: "HubSpot",
    version: "2.2.0",
    publisher: "Guild",
    summary: "HubSpot CRM, marketing emails, audiences, campaigns, workflows and Analytics",
    description:
      "Adds the CRM to chats. Search contacts, companies, deals, tickets and any " +
      "other object type with the HubSpot v3 search API — free text, property " +
      "filters, ranges, sorting, paging — read one record or a hundred, follow " +
      "associations, and read the owners, properties and pipelines a query needs. " +
      "Read the legacy Analytics API: range totals and one row per page, form, " +
      "source, UTM value or geolocation, and the saved views that filter it. " +
      "Create, update and delete records of any object type; the raw API tool stays " +
      "for the endpoints these tools do not cover.\n\n" +
      "Access uses one private-app token. The token decides which objects and " +
      "properties the integration can read or write.",
    docs_url: "https://developers.hubspot.com/docs/api/overview",
    categories: ["crm"],
    traits: {},
    auth_kind: "org_secret",
    identity_key: "email",
    fields: [
      {
        name: "base_url",
        kind: "string",
        label: "API URL",
        required: false,
        default: "https://api.hubapi.com",
        help: "Override only for a HubSpot API proxy",
        placeholder: null,
        obtain: "Leave the default. Change it only when HubSpot API traffic must go through a proxy.",
      },
      {
        name: "token",
        kind: "secret",
        label: "Private app token",
        required: true,
        default: null,
        help: null,
        placeholder: "pat-…",
        obtain:
          "As a HubSpot super admin, open **Settings → Integrations → Private Apps → Create a " +
          "private app** (in newer accounts: **Development → Legacy apps → Create → Private**). " +
          "Under **Scopes** grant the objects the chat must reach — " +
          "`crm.objects.contacts.read`, `crm.objects.companies.read`, " +
          "`crm.objects.deals.read`, `crm.objects.deals.write`, " +
          "`tickets`, and a custom object's own scope. Marketing investigations also need " +
          "`content` (email details/events), `marketing.campaigns.read`, `crm.lists.read`, " +
          "and `automation` (workflows). Save the scopes, then copy the " +
          "access token (`pat-…`). See [HubSpot private " +
          "apps](https://developers.hubspot.com/docs/api/private-apps).",
      },
    ],
    tools: [
      searchTool("search_contacts", "Search HubSpot contacts by free text and property filters."),
      searchTool("search_companies", "Search HubSpot companies by free text and property filters."),
      searchTool("search_deals", "Search HubSpot deals by free text and property filters."),
      searchTool("search_tickets", "Search HubSpot tickets by free text and property filters."),
      {
        name: "search_objects",
        class: "read" as const,
        description:
          "Search records of any other HubSpot object type by free text and property filters: a " +
          "standard one the named searches do not cover (notes, tasks, meetings, products, line_items) " +
          "or a custom one. The object type is the id HubSpot shows in the object's settings " +
          "(p148247336_subscriptions) or its numeric id (2-12345). Reads only.",
        parameters: {
          type: "object",
          properties: { object_type: OBJECT_TYPE("The object type id"), ...SEARCH_PARAMETERS.properties },
          required: ["object_type"],
        },
      },
      {
        name: "get_object",
        class: "read" as const,
        description: "Read one HubSpot record by id, with the properties and associations the call names. Reads only.",
        parameters: {
          type: "object",
          properties: {
            object_type: OBJECT_TYPE("contacts, companies, deals, tickets, or another object type id"),
            id: { type: "string", description: "The record's internal id" },
            properties: { type: "array", items: { type: "string" }, description: "Properties to return" },
            propertiesWithHistory: {
              type: "array",
              items: { type: "string" },
              description: "Properties whose historical values and sources to return, e.g. region",
            },
            associations: {
              type: "array",
              items: { type: "string" },
              description: 'Object types whose associated ids to return, e.g. ["deals"]',
            },
          },
          required: ["object_type", "id"],
        },
      },
      {
        name: "batch_read",
        class: "read" as const,
        description: "Read up to 100 HubSpot records of one object type by id in one call. Reads only.",
        parameters: {
          type: "object",
          properties: {
            object_type: OBJECT_TYPE("contacts, companies, deals, tickets, or another object type id"),
            ids: { type: "array", items: { type: "string" }, description: "Record ids, at most 100" },
            properties: { type: "array", items: { type: "string" }, description: "Properties to return" },
          },
          required: ["object_type", "ids"],
        },
      },
      {
        name: "get_associations",
        class: "read" as const,
        description:
          "Read the ids of the records associated with one HubSpot record, e.g. the deals of a " +
          "company. Reads only.",
        parameters: {
          type: "object",
          properties: {
            object_type: OBJECT_TYPE("The record's object type"),
            id: { type: "string", description: "The record's internal id" },
            to_object_type: OBJECT_TYPE("The associated object type"),
          },
          required: ["object_type", "id", "to_object_type"],
        },
      },
      {
        name: "list_owners",
        class: "read" as const,
        description: "List the org's HubSpot owners, so an owner id reads as a name and an email. Reads only.",
        parameters: {
          type: "object",
          properties: {
            limit: { type: "number", description: "1-100 owners, default 50" },
            after: { type: "string", description: "The `after` cursor a previous call returned" },
          },
        },
      },
      {
        name: "list_properties",
        class: "read" as const,
        description:
          "List one object type's HubSpot properties: the names a filter can use, and the values an " +
          "enum property accepts. Reads only.",
        parameters: {
          type: "object",
          properties: {
            object_type: OBJECT_TYPE("contacts, companies, deals, tickets, or another object type id"),
            query: { type: "string", description: "Keep only the properties whose name or label contains this" },
          },
          required: ["object_type"],
        },
      },
      {
        name: "list_pipelines",
        class: "read" as const,
        description:
          "List the pipelines and stages of one object type (deals, tickets), with the stage ids a " +
          "stage filter needs. Reads only.",
        parameters: objectTypeParameter("deals, tickets, or another pipelined object type"),
      },
      {
        name: "get_analytics",
        class: "read" as const,
        description:
          "Read HubSpot's legacy Analytics API for one date range: the totals of the range and one " +
          "row per page, form, social asset, source, UTM value, geolocation or session. `report` picks " +
          "the family and `period` the grouping; the rows carry the metric names (visits, rawViews, " +
          "contacts, submissions, bounceRate, timePerSession …) and `totals` sums the whole range. " +
          "Page with `offset`. Needs the business-intelligence scope. Reads only.",
        parameters: {
          type: "object",
          properties: {
            report: {
              type: "string",
              enum: [...ANALYTICS_REPORTS],
              description:
                "Which report: hosted content (landing-pages, standard-pages, blog-posts, " +
                "listing-pages, knowledge-articles), session breakdowns (totals, sessions, sources, " +
                "geolocation, utm-campaigns, utm-contents, utm-mediums, utm-sources, utm-terms), or " +
                "object engagement (pages, forms, event-completions, social-assists)",
            },
            period: {
              type: "string",
              enum: [...ANALYTICS_PERIODS],
              description:
                "How the rows group the range: total (one row per asset for the whole range), " +
                "daily/weekly/monthly (one row per asset per bucket), summarize/* (the same plus a " +
                "summary row)",
            },
            start: { type: "string", description: "Range start as YYYYMMDD, e.g. 20260901" },
            end: { type: "string", description: "Range end as YYYYMMDD, inclusive" },
            drilldown: {
              type: "array",
              items: { type: "string" },
              description: "One or two values that drill into the report, in order (d1, d2)",
            },
            filter: {
              type: "array",
              items: { type: "string" },
              description: 'Keep only these breakdown values, e.g. ["/pricing"]',
            },
            exclude: {
              type: "array",
              items: { type: "string" },
              description: "Drop these breakdown values",
            },
            view_id: {
              type: "number",
              description: "An Analytics view id from list_analytics_views; its saved filters apply",
            },
            sort: { type: "string", description: "Metric to sort the rows by, e.g. visits" },
            sort_dir: { type: "string", enum: ["ASC", "DESC"], description: "Default DESC" },
            limit: { type: "number", description: "1-350 rows, default 25" },
            offset: { type: "number", description: "Rows to skip; the `More rows` line gives the next value" },
          },
          required: ["report", "period", "start", "end"],
        },
      },
      {
        name: "list_analytics_views",
        class: "read" as const,
        description:
          "List the org's saved HubSpot Analytics views: the id get_analytics takes as `view_id`, and " +
          "the filters each view holds. Reads only.",
        parameters: { type: "object", properties: {} },
      },
      {
        name: "analytics_exists",
        class: "read" as const,
        description:
          "Check whether HubSpot has analytics data for one object type, e.g. a custom object. " + "Reads only.",
        parameters: objectTypeParameter("The object type id, e.g. pages or p148247336_subscriptions"),
      },
      {
        name: "create_object",
        class: "write",
        description: "Create one HubSpot record of any object type.",
        parameters: {
          type: "object",
          properties: {
            object_type: OBJECT_TYPE("contacts, companies, deals, tickets, or another object type id"),
            properties: { type: "object", description: 'Properties to set, e.g. {"dealname": "North"}' },
          },
          required: ["object_type", "properties"],
        },
      },
      {
        name: "update_object",
        class: "write",
        description: "Update properties of one HubSpot record of any object type.",
        parameters: {
          type: "object",
          properties: {
            object_type: OBJECT_TYPE("contacts, companies, deals, tickets, or another object type id"),
            id: { type: "string", description: "The record's internal id" },
            properties: { type: "object", description: 'Properties to set, e.g. {"amount": "1000"}' },
          },
          required: ["object_type", "id", "properties"],
        },
      },
      {
        name: "delete_object",
        class: "write",
        description: "Delete one HubSpot record of any object type. It moves the record to the recycle bin.",
        parameters: {
          type: "object",
          properties: {
            object_type: OBJECT_TYPE("contacts, companies, deals, tickets, or another object type id"),
            id: { type: "string", description: "The record's internal id" },
          },
          required: ["object_type", "id"],
        },
      },
      ...[
        {
          name: "list_marketing_emails",
          description:
            "Page through marketing emails. Returns complete JSON with paging.next.after; inspect names on each page. Needs content or an accepted granular email scope.",
          properties: {
            ...MARKETING_PAGE,
            createdAfter: { type: "string", description: "ISO8601 creation time lower bound" },
            createdBefore: { type: "string", description: "ISO8601 creation time upper bound" },
          },
        },
        {
          name: "get_marketing_email",
          description:
            "Read the complete marketing email, including content, audience settings, statistics and attribution. publishedByEmail/Id/Name identify its publisher/sender; createdById identifies its creator; from is the visible sender address. A list owner is not proof of who sent an email.",
          properties: { id: MARKETING_ID },
          required: ["id"],
        },
        {
          name: "get_email_events",
          description:
            "Page actual email events: SENT, DELIVERED, BOUNCE, OPEN, CLICK. Use campaignId from the email's primaryEmailCampaignId, not its content id or a marketing campaign UUID. Follow offset while hasMore is true. Counts from contact last-email properties are not full send history.",
          properties: {
            limit: MARKETING_PAGE.limit,
            offset: { type: "string", description: "Opaque offset from the previous response" },
            campaignId: { type: "string" },
            recipient: { type: "string" },
            eventType: {
              type: "string",
              enum: [
                "SENT",
                "DELIVERED",
                "BOUNCE",
                "OPEN",
                "CLICK",
                "DEFERRED",
                "DROPPED",
                "SPAMREPORT",
                "STATUSCHANGE",
                "SUPPRESSION",
                "UNBOUNCE",
              ],
            },
            startTimestamp: { type: "number", description: "Range start, Unix milliseconds" },
            endTimestamp: { type: "number", description: "Range end, Unix milliseconds" },
          },
        },
        {
          name: "search_lists",
          description:
            "Search audience lists by name or enumerate them. Returns complete lists and offset; repeat with that offset while hasMore. Uses read-only POST search, never creates or edits a list.",
          properties: {
            query: { type: "string" },
            objectTypeId: { type: "string", description: "e.g. 0-1 for contacts" },
            count: { type: "integer", minimum: 1, maximum: 100, default: 25 },
            offset: { type: "integer", minimum: 0, default: 0 },
          },
        },
        {
          name: "get_list",
          description:
            "Read one audience list with filters, processing type and creator/updater ids. These identify list maintainers, not the publisher of an email. Current membership does not prove send-time membership.",
          properties: { id: MARKETING_ID },
          required: ["id"],
        },
        {
          name: "get_list_members",
          description:
            "Page current member record ids of a list. Follow paging.next.after. Read properties with batch_read; this is current membership, not an email's historical recipient list.",
          properties: { id: MARKETING_ID, ...MARKETING_PAGE },
          required: ["id"],
        },
        {
          name: "get_list_memberships",
          description:
            "Read the lists a CRM record currently belongs to. object_type_id is a numeric object type such as 0-1 for contacts. This does not prove historical membership or receipt of an email.",
          properties: { object_type_id: { type: "string" }, id: MARKETING_ID },
          required: ["object_type_id", "id"],
        },
        {
          name: "list_campaigns",
          description:
            "Page marketing campaigns (broader groups of assets, not individual email sends). Needs marketing.campaigns.read; follow paging.next.after.",
          properties: MARKETING_PAGE,
        },
        {
          name: "get_campaign",
          description:
            "Read one marketing campaign by UUID. To inspect its associated emails or other assets, use list_campaign_assets.",
          properties: { id: MARKETING_ID },
          required: ["id"],
        },
        {
          name: "list_campaign_assets",
          description:
            "Page assets of one marketing campaign and one asset type, e.g. MARKETING_EMAIL. Follow paging.next.after.",
          properties: { id: MARKETING_ID, asset_type: { type: "string" }, ...MARKETING_PAGE },
          required: ["id", "asset_type"],
        },
        {
          name: "list_workflows",
          description:
            "Page v4 workflows. Needs automation; follow paging.next.after. This endpoint does not list classic v3 workflows; an empty page is not proof no automation exists.",
          properties: MARKETING_PAGE,
        },
        {
          name: "get_workflow",
          description:
            "Read a v4 workflow's full definition, triggers, actions and enabled state. Needs automation. A definition alone does not prove an individual contact received an email.",
          properties: { id: MARKETING_ID },
          required: ["id"],
        },
        {
          name: "check_capabilities",
          description:
            "Probe effective access to CRM, marketing emails, delivery events, lists, campaigns and workflows separately. Reports each result and API error; a successful contacts connection test does not prove marketing access.",
          properties: {},
        },
      ].map(({ name, description, properties, ...rest }) => ({
        name,
        description,
        class: "read" as const,
        parameters: { type: "object", properties, ...rest },
      })),
      apiTool("HubSpot"),
    ],
  },
  async testConnection(config: JsonObject, secrets) {
    const token = secret(secrets, "token");
    const url = new URL(`${hubspotBaseUrl(config)}/crm/v3/objects/contacts`);
    url.searchParams.set("limit", "1");
    await probe(
      fetch(url, fetchTimeout(PROBE_TIMEOUT_MS, { headers: { authorization: `Bearer ${token}` } })),
      "hubspot",
    );
  },
  execute: hubspotExecute,
};

export default plugin;
