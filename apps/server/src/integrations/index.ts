// The installed integrations, in priority order. This is the only place a
// new integration is listed: its folder carries the manifest, the tool
// declarations, the execute function, and the logo.

import grafana from "./grafana/integration.js";
import searxng from "./searxng/integration.js";
import firecrawl from "./firecrawl/integration.js";
import googleWorkspace from "./google_workspace/integration.js";
import hubspot from "./hubspot/integration.js";
import langfuse from "./langfuse/integration.js";
import atlassian from "./atlassian/integration.js";
import slack from "./slack/integration.js";
import github from "./github/integration.js";
import gitlab from "./gitlab/integration.js";
import type { IntegrationPlugin } from "./types.js";

export const PLUGINS: IntegrationPlugin[] = [
  grafana,
  searxng,
  firecrawl,
  googleWorkspace,
  hubspot,
  langfuse,
  atlassian,
  slack,
  github,
  gitlab,
];
