import { hubspotBaseUrl, secret } from "../shared.js";
import { fetchTimeout, probe } from "../probe.js";
import type { Json } from "../shared.js";
import type { IntegrationPlugin } from "../types.js";
import { hubspotExecute } from "./execute.js";
import { apiTool } from "../api-tool.js";

const searchTool = (name: string, noun: string) => ({
  name,
  class: "read" as const,
  description: `Search HubSpot ${noun} by free-text query (CRM v3 search).`,
  parameters: {
    type: "object",
    properties: {
      query: { type: "string" },
      limit: { type: "number", description: "1-100 results, default 10" },
    },
    required: ["query"],
  },
});

const plugin: IntegrationPlugin = {
  manifest: {
    name: "hubspot",
    title: "HubSpot",
    version: "1.0.0",
    publisher: "Guild",
    summary: "HubSpot CRM: search contacts, companies, and deals; update deals",
    description:
      "Adds the CRM to chats. Search contacts, companies, and deals with the " +
      "HubSpot v3 search API, read the properties that matter, and update a deal " +
      "when a conversation changes its state.\n\n" +
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
      },
      {
        name: "token",
        kind: "secret",
        label: "Private app token",
        required: true,
        default: null,
        help: null,
        placeholder: "pat-…",
      },
    ],
    tools: [
      searchTool("search_contacts", "contacts"),
      searchTool("search_companies", "companies"),
      searchTool("search_deals", "deals"),
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
  async testConnection(config: Json, secrets) {
    const token = secret(secrets, "token");
    const url = new URL(`${hubspotBaseUrl(config)}/crm/v3/objects/contacts`);
    url.searchParams.set("limit", "1");
    await probe(fetch(url, fetchTimeout({ headers: { authorization: `Bearer ${token}` } })), "hubspot");
  },
  execute: hubspotExecute,
};

export default plugin;
