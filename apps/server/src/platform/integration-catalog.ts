// The compiled-in integration kinds as static manifest metadata — name,
// categories,
// settings schema and tool classes. This is what the admin API's
// `available` list and the configured-row categories/secrets/settings
// rendering need; tool declarations and connection tests stay Rust-side
// (the save/tools routes remain proxied until the connector ports land).

/** One admin-facing configuration field (guild_core FieldSpec). */
export interface FieldSpec {
  name: string;
  /** string | text | number | boolean | secret */
  kind: string;
  label: string | null;
  required: boolean;
  default: unknown;
  help: string | null;
  placeholder: string | null;
}

/** In-code manifest metadata (guild_core BundleManifest, kind integration). */
export interface ConnectorManifest {
  name: string;
  version: string;
  description: string;
  /** Display order: search, fetch, other (category_strings display_rank). */
  categories: string[];
  /** Credential field names: secret-kind fields derive them; otherwise the
   *  declared list (same rule as in_code_manifest). */
  secret_names: string[];
  auth_kind: string;
  identity_key: string;
  fields: FieldSpec[];
}

function field(
  name: string,
  kind: string,
  extra: Partial<Omit<FieldSpec, "name" | "kind">> = {},
): FieldSpec {
  return {
    name,
    kind,
    label: null,
    required: false,
    default: null,
    help: null,
    placeholder: null,
    ...extra,
  };
}

const FIRECRAWL_BASE_URL = "http://host.docker.internal:13002";

/** The compiled-in kinds, in registry order (integration_names()). */
export const CONNECTORS: ConnectorManifest[] = [
  {
    name: "searxng",
    version: "1.0.0",
    description: "Web search through a SearxNG instance",
    categories: ["search"],
    secret_names: [],
    auth_kind: "org_secret",
    identity_key: "email",
    fields: [
      field("base_url", "string", {
        required: true,
        placeholder: "http://searxng:8080",
      }),
    ],
  },
  {
    name: "superproxy",
    version: "1.0.0",
    description: "Fetch web pages as markdown through the superproxy gateway",
    categories: ["fetch"],
    // No declared secrets: the gateway token is optional (legacy config
    // fallback), so the enable gate must not require it.
    secret_names: [],
    auth_kind: "org_secret",
    identity_key: "email",
    fields: [
      field("base_url", "string", {
        required: true,
        placeholder: "http://superproxy:15505",
      }),
      field("token", "string", {
        help: "Legacy fallback; prefer storing the token secret instead",
      }),
    ],
  },
  {
    name: "firecrawl",
    version: "1.0.0",
    description:
      "Search the web and fetch pages as markdown through a self-hosted Firecrawl API (plus site link mapping; crawl jobs are not exposed as tools)",
    categories: ["search", "fetch"],
    secret_names: ["api_key"],
    auth_kind: "org_secret",
    identity_key: "email",
    fields: [
      field("base_url", "string", {
        default: FIRECRAWL_BASE_URL,
        help: "Self-hosted Firecrawl API URL",
      }),
      field("api_key", "secret", {
        help: "Sent as the Bearer token; the self-hosted API does not require it",
      }),
    ],
  },
  {
    name: "google_workspace",
    version: "1.0.0",
    description: "Read-only Google Workspace tools: Gmail, Calendar, Drive, Admin Directory",
    categories: ["other"],
    secret_names: ["service_account_json"],
    // Org-wide service account; the per-call acting identity rides the
    // token `sub` claim (identity_key "email").
    auth_kind: "org_secret_impersonated",
    identity_key: "email",
    fields: [
      field("api_base", "string", {
        default: "https://www.googleapis.com",
        help: "Override only for a Google API proxy",
      }),
      field("token_url", "string", {
        default: "https://oauth2.googleapis.com/token",
        help: "Override only for a Google API proxy",
      }),
      field("admin_email", "string", {
        required: true,
        help: "workspace admin the service account acts as by default",
        placeholder: "admin@yourorg.com",
      }),
      field("service_account_json", "secret", { required: true }),
    ],
  },
  {
    name: "hubspot",
    version: "1.0.0",
    description: "HubSpot CRM: search contacts, companies, and deals; update deals",
    categories: ["other"],
    secret_names: ["token"],
    auth_kind: "org_secret",
    identity_key: "email",
    fields: [
      field("base_url", "string", {
        default: "https://api.hubapi.com",
        help: "Override only for a HubSpot API proxy",
      }),
      field("token", "secret", { required: true }),
    ],
  },
  {
    name: "langfuse",
    version: "1.0.0",
    description: "Langfuse LLM observability: list and inspect traces, list prompts",
    categories: ["other"],
    secret_names: ["public_key", "secret_key"],
    auth_kind: "org_secret",
    identity_key: "email",
    fields: [
      field("base_url", "string", {
        default: "https://cloud.langfuse.com",
        help: "Override for self-hosted Langfuse",
      }),
      field("public_key", "secret", { required: true }),
      field("secret_key", "secret", { required: true }),
    ],
  },
  {
    name: "atlassian",
    version: "1.0.0",
    description: "Jira and Confluence Cloud: search and read issues and pages, create pages",
    categories: ["other"],
    secret_names: ["token"],
    auth_kind: "org_secret",
    identity_key: "email",
    fields: [
      field("site", "string", {
        required: true,
        placeholder: "https://yourorg.atlassian.net",
        help: "your Jira/Confluence cloud site",
      }),
      field("email", "string", {
        required: true,
        help: "the account the API token belongs to",
      }),
      field("token", "secret", { required: true }),
    ],
  },
  {
    name: "slack",
    version: "1.0.0",
    description: "Slack: list channels and users, read channel history, post messages",
    categories: ["other"],
    secret_names: ["bot_token"],
    auth_kind: "org_secret",
    identity_key: "email",
    fields: [
      field("base_url", "string", {
        default: "https://slack.com/api",
        help: "Override only for a Slack API proxy",
      }),
      field("bot_token", "secret", { required: true }),
    ],
  },
  {
    name: "github",
    version: "1.0.0",
    description: "GitHub repositories, issues, pull requests, and files",
    categories: ["other"],
    secret_names: ["token"],
    auth_kind: "org_secret",
    identity_key: "email",
    fields: [
      field("api_url", "string", {
        default: "https://api.github.com",
        help: "Override for GitHub Enterprise Server",
      }),
      field("token", "secret", { required: true }),
    ],
  },
  {
    name: "gitlab",
    version: "1.0.0",
    description: "GitLab projects, issues, and merge requests",
    categories: ["other"],
    secret_names: ["token"],
    auth_kind: "org_secret",
    identity_key: "email",
    fields: [
      field("base_url", "string", {
        default: "https://gitlab.com/api/v4",
        help: "Override for self-hosted GitLab (API root)",
      }),
      field("token", "secret", { required: true }),
    ],
  },
];

export function connectorByName(name: string): ConnectorManifest | undefined {
  return CONNECTORS.find((c) => c.name === name);
}

export const CONNECTOR_NAMES: string[] = CONNECTORS.map((c) => c.name);
