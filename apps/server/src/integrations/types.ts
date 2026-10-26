// The integration plugin contract: one folder per integration carries a
// manifest (shop metadata, settings fields, tool declarations, traits) and
// an execute function. The core knows only this shape — adding an
// integration touches its folder and the plugin index, nothing else.

import type { Json, ToolOutcome } from "./shared.js";

/** One admin-facing settings field (the shop's configure form schema). */
export interface IntegrationField {
  name: string;
  /** string | text | number | boolean | secret */
  kind: string;
  label: string | null;
  required: boolean;
  default: unknown;
  help: string | null;
  placeholder: string | null;
}

/** One tool the integration contributes. `class` is the policy floor:
 *  read, write, or admin. */
export interface IntegrationToolDecl {
  name: string;
  class: "read" | "write" | "admin";
  description: string;
  /** JSON Schema object. */
  parameters: unknown;
}

/** A trait is a capability with a Guild-provided name and description; the
 *  integration supplies the implementation. The map value is the provider's
 *  own tool name. */
export type IntegrationTraits = Record<string, string>;

export interface IntegrationManifest {
  name: string;
  title: string;
  version: string;
  publisher: string;
  /** One line for the shop card. */
  summary: string;
  /** Markdown for the shop detail page. */
  description: string;
  docs_url: string | null;
  categories: string[];
  traits: IntegrationTraits;
  auth_kind: string;
  identity_key: string;
  fields: IntegrationField[];
  tools: IntegrationToolDecl[];
}

/** A plugin as its folder exports it. */
export interface IntegrationPlugin {
  manifest: IntegrationManifest;
  /** Rejects a broken row config before the tool surface is declared. */
  validate?(config: Json): void;
  /** The shop's save gate: a probe against the would-be configuration. */
  testConnection(config: Json, secrets: [string, string][]): Promise<void>;
  execute(
    config: Json,
    tool: string,
    args: Json,
    secrets: [string, string][],
    actingAs: string | null,
  ): Promise<ToolOutcome>;
}
