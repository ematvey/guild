import { mcpIntegration } from "@guild/integration-sdk";

export default mcpIntegration({
  name: "stripe",
  title: "Stripe",
  version: "1.0.0",
  publisher: "Guild",
  summary: "Stripe's hosted MCP server: read and change payments, customers, billing and balances",
  description:
    "Stripe account access through Stripe's MCP server. Find the API method first: stripe_api_search by keyword, " +
    "then stripe_api_details for its parameters. Then call stripe_api_read for GET methods and stripe_api_write for " +
    "POST, PATCH, PUT and DELETE. Amounts are integers in the currency's smallest unit (cents for USD). A test-mode " +
    "key (rk_test_) sees only test data. Writes such as refunds, payouts and money movement may wait for a " +
    "reviewer's approval in the Stripe Dashboard. search_stripe_documentation answers questions about Stripe itself.",
  docs_url: "https://docs.stripe.com/mcp",
  categories: ["payments", "billing"],
  mcp: {
    url: "https://mcp.stripe.com",
    headers: { Authorization: "Bearer {stripe_key}", "Stripe-Account": "{stripe_account}" },
    envelope: false,
  },
  fields: [
    {
      name: "stripe_key",
      kind: "secret",
      label: "Agent API key",
      required: true,
      default: null,
      help: "A restricted key tagged for agent access (rk_live_… or rk_test_…). Grant only the permissions agents need.",
      placeholder: "rk_live_…",
      obtain:
        'Stripe Dashboard → Developers → API keys → Create restricted key → choose "Authorizing agent access to ' +
        'your account". From December 2026 Stripe MCP accepts only agent-tagged keys.',
    },
    {
      name: "stripe_account",
      kind: "secret",
      label: "Connected account (optional)",
      required: false,
      default: null,
      help: "Connect platforms only: an acct_… id makes every call act on that connected account. Leave empty to act on your own account.",
      placeholder: "acct_…",
      obtain: "Stripe Dashboard → Connect → Accounts → the account's id.",
    },
  ],
});
