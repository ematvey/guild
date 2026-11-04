// @guild/integration-sdk: the contract between Guild and an integration
// plugin. A plugin module's default export is an `IntegrationPlugin`; the
// request helpers here are what every integration (built-in or published)
// builds on. A published plugin bundles this package into its plugin.js.

export type {
  IntegrationField,
  IntegrationManifest,
  IntegrationPlugin,
  IntegrationToolDecl,
  IntegrationTraits,
} from "./types.js";
export * from "./shared.js";
export { PROBE_TIMEOUT_MS, probe } from "./probe.js";
export { assertPublicFetchTarget } from "./fetch-target.js";
export { isNonPublicAddress } from "./ip-guard.js";
export { apiTool } from "./api-tool.js";
export { traitNames, traitSpec, type TraitSpec } from "./traits.js";
export { registryManifest } from "./bundle-manifest.js";
