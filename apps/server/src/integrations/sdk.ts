// The integration plugin SDK: the one module a plugin outside this tree
// imports. Organization-specific plugins live in `integrations/private/`
// (gitignored, see its README) and reach the server through these names
// only, so the server's internal layout can move without breaking them.

export type { IntegrationField, IntegrationManifest, IntegrationPlugin, IntegrationToolDecl } from "./types.js";
export type { JsonObject, ToolOutcome, ApiAuth } from "./shared.js";
export {
  API_MAX_CHARS,
  API_TIMEOUT_MS,
  CALL_TIMEOUT_MS,
  FETCH_TIMEOUT_MS,
  LIST_TIMEOUT_MS,
  MAX_BODY_CHARS,
  VENDOR_API_MAX_CHARS,
  callVendorApi,
  clampNumber,
  configString,
  excerpt,
  fetchJson,
  fetchTimeout,
  pathSegment,
  readBodyCapped,
  requestJson,
  secret,
  secretOrNull,
  transportCause,
  trimTrailingSlash,
  truncateWithMarker,
  urlencode,
} from "./shared.js";
export { PROBE_TIMEOUT_MS, probe } from "./probe.js";
export { assertPublicFetchTarget } from "./fetch-target.js";
export { apiTool } from "./api-tool.js";
export { traitNames } from "./traits.js";
