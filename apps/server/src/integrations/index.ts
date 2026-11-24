// The installed integrations, in priority order. This is the only place a
// new integration is listed: its folder carries the manifest, the tool
// declarations, the execute function, and the logo. An MCP plugin's folder
// carries its manifest (the remote server and settings), README and logo.

import grafana from "./grafana/integration.js";
import searxng from "./searxng/integration.js";
import firecrawl from "./firecrawl/integration.js";
import googleWorkspace from "./google_workspace/integration.js";
import hubspot from "./hubspot/integration.js";
import langfuse from "./langfuse/integration.js";
import posthog from "./posthog/integration.js";
import atlassian from "./atlassian/integration.js";
import slack from "./slack/integration.js";
import github from "./github/integration.js";
import gitlab from "./gitlab/integration.js";
import stripe from "./stripe/integration.js";
import clickhouse from "./clickhouse/integration.js";
import postgres from "./postgres/integration.js";
import type { GuildPlugin } from "@guild/integration-sdk";

export const PLUGINS: GuildPlugin[] = [
  grafana,
  searxng,
  firecrawl,
  googleWorkspace,
  hubspot,
  langfuse,
  posthog,
  atlassian,
  slack,
  github,
  gitlab,
  stripe,
  clickhouse,
  postgres,
];
