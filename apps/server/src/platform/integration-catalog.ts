// The integration catalog the server reads: the loaded plugins from
// src/integrations plus the types the admin API and the runtime share. The
// implementations live in their own folders; this module is the seam.

export {
  INTEGRATIONS,
  integrationByName,
  traitForTool,
  traitProviders,
  type BuiltinIntegration,
  type IntegrationField,
  type IntegrationManifest,
  type IntegrationToolDecl,
  type IntegrationToolSpec,
} from "../integrations/loader.js";
