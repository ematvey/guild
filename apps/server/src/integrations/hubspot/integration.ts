import { hubspotBaseUrl, secret } from "../shared.js";
import { PROBE_TIMEOUT_MS, probe } from "@guild/integration-sdk";
import { fetchTimeout } from "../shared.js";
import type { JsonObject } from "../shared.js";
import type { IntegrationPlugin } from "@guild/integration-sdk";
import { hubspotExecute } from "./execute.js";
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

const plugin: IntegrationPlugin = {
  manifest: {
    name: "hubspot",
    title: "HubSpot",
    version: "1.1.0",
    publisher: "Guild",
    summary: "HubSpot CRM: search contacts, companies, deals, tickets and custom objects; update deals",
    description:
      "Adds the CRM to chats. Search contacts, companies, deals, tickets and any " +
      "custom object with the HubSpot v3 search API — free text, property filters, " +
      "ranges, sorting, paging — and update a deal when a conversation changes its " +
      "state.\n\n" +
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
          "Under **Scopes** grant `crm.objects.contacts.read`, `crm.objects.companies.read`, " +
          "`crm.objects.deals.read` and `crm.objects.deals.write`, create the app, and copy its " +
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
        name: "search_custom",
        class: "read" as const,
        description:
          "Search records of one HubSpot custom object by free text and property filters. " +
          "The object type is its id, as HubSpot shows it in the object's settings " +
          "(p148247336_subscriptions) or its numeric id (2-12345). Reads only.",
        parameters: {
          type: "object",
          properties: {
            object_type: { type: "string", description: "The custom object's type id" },
            ...SEARCH_PARAMETERS.properties,
          },
          required: ["object_type"],
        },
      },
      {
        name: "update_deal",
        class: "write",
        description: "Update properties of one HubSpot deal by id.",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string", description: "Deal id (internal numeric id)" },
            properties: {
              type: "object",
              description: 'Deal properties to set, e.g. {"amount": "1000"}',
            },
          },
          required: ["id", "properties"],
        },
      },
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
