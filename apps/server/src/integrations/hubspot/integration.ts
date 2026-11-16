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

const OBJECT_TYPE = (description: string) => ({ type: "string", description });

/** The object type a call names, for the tools that reach every object. */
const objectTypeParameter = (description: string) => ({
  type: "object",
  properties: { object_type: OBJECT_TYPE(description) },
  required: ["object_type"],
});

const plugin: IntegrationPlugin = {
  manifest: {
    name: "hubspot",
    title: "HubSpot",
    version: "2.0.0",
    publisher: "Guild",
    summary: "HubSpot CRM: search, read, create, update and delete any object",
    description:
      "Adds the CRM to chats. Search contacts, companies, deals, tickets and any " +
      "other object type with the HubSpot v3 search API — free text, property " +
      "filters, ranges, sorting, paging — read one record or a hundred, follow " +
      "associations, and read the owners, properties and pipelines a query needs. " +
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
          "`tickets`, and a custom object's own scope — create the app, and copy its " +
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
        description:
          "Read one HubSpot record by id, with the properties and associations the call names. Reads only.",
        parameters: {
          type: "object",
          properties: {
            object_type: OBJECT_TYPE("contacts, companies, deals, tickets, or another object type id"),
            id: { type: "string", description: "The record's internal id" },
            properties: { type: "array", items: { type: "string" }, description: "Properties to return" },
            associations: {
              type: "array",
              items: { type: "string" },
              description: "Object types whose associated ids to return, e.g. [\"deals\"]",
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
