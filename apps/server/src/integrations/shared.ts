// The built-in integrations' shared surface: the SDK every plugin builds on
// (re-exported, so a built-in imports one module) plus the vendor base-URL
// resolvers and constants only the built-ins use.

import { configString, secretOrNull, trimTrailingSlash, type JsonObject } from "@guild/integration-sdk";

export * from "@guild/integration-sdk";

export const SCRAPE_EXCERPT_CHARS = 2_000;
export const MAP_LINK_LIMIT = 500;
export const FIRECRAWL_DEFAULT_BASE_URL = "http://host.docker.internal:13002";

// ---------- vendor base-URL resolvers (the runtime path) ----------

const GITHUB_DEFAULT_API = "https://api.github.com";
const GITLAB_DEFAULT_API = "https://gitlab.com/api/v4";
const GOOGLE_DEFAULT_API_BASE = "https://www.googleapis.com";
const GOOGLE_DEFAULT_TOKEN_URL = "https://oauth2.googleapis.com/token";

export function githubApiUrl(config: JsonObject): string {
  const v = configString(config, "api_url");
  return v !== undefined ? trimTrailingSlash(v) : GITHUB_DEFAULT_API;
}

export function gitlabBaseUrl(config: JsonObject): string {
  const raw = configString(config, "base_url");
  const trimmed = raw !== undefined ? raw.trim().replace(/\/+$/, "") : null;
  if (trimmed === null || trimmed === "") return GITLAB_DEFAULT_API;
  // has_url_path: a string without `://` always counts as carrying a path;
  // a URL whose authority is followed by `/…` keeps its path as-is, a bare
  // host gains the /api/v4 prefix.
  const schemeSplit = trimmed.split("://");
  const hasUrlPath = schemeSplit.length === 1 ? true : schemeSplit[1]!.includes("/");
  return hasUrlPath ? trimmed : `${trimmed}/api/v4`;
}

export function hubspotBaseUrl(config: JsonObject): string {
  return trimTrailingSlash(configString(config, "base_url") ?? "https://api.hubapi.com");
}

export function langfuseBaseUrl(config: JsonObject, secrets: [string, string][]): string {
  // The config base_url wins; the legacy `host` secret of pre-schema
  // deployments is the fallback; else the public cloud.
  const fromConfig = configString(config, "base_url");
  if (fromConfig !== undefined) return trimTrailingSlash(fromConfig);
  const host = secretOrNull(secrets, "host");
  if (host !== null) return trimTrailingSlash(host);
  return "https://cloud.langfuse.com";
}

export function slackBaseUrl(config: JsonObject): string {
  return trimTrailingSlash(configString(config, "base_url") ?? "https://slack.com/api");
}

export function firecrawlBaseUrl(config: JsonObject): string {
  const fromConfig = configString(config, "base_url");
  return trimTrailingSlash(fromConfig !== undefined && fromConfig !== "" ? fromConfig : FIRECRAWL_DEFAULT_BASE_URL);
}

export function googleApiBase(config: JsonObject): string {
  const v = configString(config, "api_base");
  return v !== undefined ? v.replace(/\/+$/, "") : GOOGLE_DEFAULT_API_BASE;
}

export function googleTokenUrl(config: JsonObject): string {
  const v = configString(config, "token_url");
  return v !== undefined ? v.replace(/\/+$/, "") : GOOGLE_DEFAULT_TOKEN_URL;
}

export function searxngBaseUrl(config: JsonObject): string {
  const base = configString(config, "base_url");
  if (base === undefined) throw new Error("searxng config requires base_url");
  return trimTrailingSlash(base);
}

export function atlassianSite(config: JsonObject, secrets: [string, string][]): string {
  const site = configString(config, "site") ?? secretOrNull(secrets, "site");
  if (site === undefined || site === null || site === "") throw new Error("atlassian requires the site setting");
  return trimTrailingSlash(site);
}
