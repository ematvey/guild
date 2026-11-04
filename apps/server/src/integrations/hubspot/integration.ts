import { hubspotBaseUrl, secret } from "../shared.js";
import { PROBE_TIMEOUT_MS, probe } from "@guild/integration-sdk";
import { fetchTimeout } from "../shared.js";
import type { JsonObject } from "../shared.js";
import type { IntegrationPlugin } from "@guild/integration-sdk";
import { hubspotExecute } from "./execute.js";
import { apiTool } from "@guild/integration-sdk";

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
