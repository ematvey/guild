Connects agents to your Stripe account through Stripe's hosted MCP server (`https://mcp.stripe.com`). Guild reads the server's tool list live, so new Stripe tools appear without a Guild update.

## What agents can do

- Look up any Stripe object: customers, payments, invoices, subscriptions, products, prices, disputes, balances.
- Call any Stripe API method through `stripe_api_read` (GET) and `stripe_api_write` (POST, PATCH, PUT, DELETE), after finding it with `stripe_api_search` and `stripe_api_details`. Writes create, change or cancel real objects.
- Query metrics and run financial reports (`stripe_analytics`, preview).
- Search Stripe's documentation.
- Treasury tools (`send_money`, `transfer_money`, `convert_currency`) move money. Leave them disabled unless agents should do that.

What a call can actually reach is limited by the key's permissions, not by the tool.

## Before you start

- A Stripe account and a Dashboard role that can create API keys.
- A decision on what agents may touch. The restricted key's permissions are the limit; start read-only.
- Try it in a sandbox first with an `rk_test_` key.

## Set it up

1. In the Stripe Dashboard, open **Developers → API keys → Create restricted key**.
2. When Stripe asks how the key will be used, choose **Authorizing agent access to your account**. The key gets an **Agent** badge. From December 2026 Stripe's MCP server accepts only agent keys.
3. Grant the permissions agents need (Read for a lookup-only setup) and create the key (`rk_live_…` or `rk_test_…`).
4. In Guild, open Stripe on the integrations page and paste the key into **Agent API key**. Connect platforms may also set **Connected account** to an `acct_…` id; every call then acts on that account.
5. Click **Test connection**, then open **Tools** and enable the tools agents should see. Each tool's class comes from Stripe's own read-only and destructive hints. Check it before you enable it.
6. Enable the integration, set who may add it on the **Access** tab, and add it to agents.

## Permissions and data

All calls use the one shared key (`org_secret`), so every agent works with the same account and permissions, whoever asks. Stripe logs the calls as made by that key. Agent keys follow the approval rules set in your Stripe account, so refunds, payouts and account changes can wait for a reviewer there as well as in Guild. Guild's `x-guild-*` identity headers are not sent to Stripe.

## Troubleshooting

- **401 with an OAuth challenge.** The key is wrong, revoked, or not an agent key. Create an agent key as above.
- **A permission error on one call.** The key lacks that resource's permission. Edit the restricted key in the Dashboard.
- **Data you expect is missing.** A test key sees only sandbox data, and a set connected account limits calls to that account.

See [Stripe MCP](https://docs.stripe.com/mcp) and [restricted API keys](https://docs.stripe.com/keys/restricted-api-keys).
