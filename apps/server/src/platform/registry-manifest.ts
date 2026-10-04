// Manifest validation (crates/guild-core/src/registry.rs validate_manifest
// and validate_v2). Message texts mirror the Rust anyhow strings, including
// the FieldSpec debug render, because the publish handler passes them
// straight into the 400 body.

export interface FieldSpec {
  name: string;
  kind: string;
  label?: string | null;
  required?: boolean;
  default?: unknown;
  help?: string | null;
  placeholder?: string | null;
}

export interface Manifest {
  kind: unknown;
  slug: unknown;
  version: unknown;
  description?: unknown;
  dependencies?: unknown;
  mcp?: { url?: unknown } | null;
  auth?: { kind?: unknown; secret_names?: unknown; identity_key?: unknown } | null;
  settings?: { fields?: unknown } | null;
  tools?: { classes?: unknown } | null;
  triggers?: unknown;
  skills?: unknown;
}

export const FIELD_KINDS = ["string", "text", "number", "boolean", "secret"];
const TOOL_CLASSES = ["read", "write", "admin"];
const AUTH_KINDS = ["org_secret", "org_secret_impersonated", "per_user_token"];

/** serde Debug render of a FieldSpec (feeds the settings error messages). */
function debugField(f: FieldSpec): string {
  const opt = (v: unknown): string =>
    v === null || v === undefined ? "None" : `Some(${JSON.stringify(v)})`;
  return (
    `FieldSpec { name: ${JSON.stringify(f.name)}, kind: ${JSON.stringify(f.kind)}, ` +
    `label: ${opt(f.label)}, required: ${f.required === true}, default: ${opt(f.default)}, ` +
    `help: ${opt(f.help)}, placeholder: ${opt(f.placeholder)} }`
  );
}

export function validateManifest(m: Manifest): void {
  if (typeof m.slug !== "string" || m.slug === "") throw new Error("manifest slug is empty");
  if (m.slug.length > 64) throw new Error("manifest slug is too long");
  if (![...m.slug].every((c) => /[a-z0-9_-]/.test(c))) {
    throw new Error("manifest slug must be [a-z0-9_-]");
  }
  if (typeof m.version !== "string" || m.version === "") throw new Error("manifest version is empty");
  if (m.kind !== "skill" && m.kind !== "mcp" && m.kind !== "integration") {
    throw new Error("manifest kind must be skill, mcp, or integration");
  }
}

/** Validates v2 integration manifest fields. v1 manifests with no v2
 *  fields pass unchanged. */
export function validateV2(m: Manifest): void {
  validateManifest(m);
  if (m.mcp !== null && m.mcp !== undefined) {
    const url = m.mcp.url;
    if (typeof url !== "string" || !(url.startsWith("http://") || url.startsWith("https://"))) {
      throw new Error("mcp.url must be an absolute http(s) URL");
    }
  }
  if (m.auth !== null && m.auth !== undefined) {
    if (typeof m.auth.kind !== "string" || !AUTH_KINDS.includes(m.auth.kind)) {
      throw new Error("auth.kind must be org_secret, org_secret_impersonated, or per_user_token");
    }
    const identityKey = m.auth.identity_key === undefined || m.auth.identity_key === null ? "email" : m.auth.identity_key;
    if (identityKey !== "email" && identityKey !== "") {
      throw new Error("auth.identity_key supports only email in v1");
    }
  }
  if (m.settings !== null && m.settings !== undefined) {
    const fields = m.settings.fields;
    const seen = new Set<string>();
    if (Array.isArray(fields)) {
      for (const raw of fields) {
        const f = raw as FieldSpec;
        if (typeof f.name !== "string" || f.name === "") throw new Error("settings field name is empty");
        if (f.name.length > 64 || ![...f.name].every((c) => /[a-z0-9_]/.test(c))) {
          throw new Error(`settings field ${debugField(f)} must be [a-z0-9_] and <= 64 chars`);
        }
        if (typeof f.kind !== "string" || !FIELD_KINDS.includes(f.kind)) {
          throw new Error(`settings field ${debugField(f)} kind must be one of ${JSON.stringify(FIELD_KINDS)}`);
        }
        if (seen.has(f.name)) {
          throw new Error(`duplicate settings field ${debugField(f)}`);
        }
        seen.add(f.name);
        // The generated form treats `default` per the field kind, so the
        // JSON value must match: string for string/text, number for number,
        // boolean for boolean. Missing and null stay allowed.
        const d = f.default;
        const defaultOk =
          d === undefined ||
          d === null ||
          (f.kind === "number" ? typeof d === "number" : f.kind === "boolean" ? typeof d === "boolean" : typeof d === "string");
        if (!defaultOk) {
          throw new Error(`settings field ${debugField(f)} kind ${f.kind} needs a default of the same JSON type`);
        }
      }
    }
  }
  if (m.tools !== null && m.tools !== undefined) {
    const classes = m.tools.classes;
    if (classes !== null && classes !== undefined && typeof classes === "object") {
      for (const [name, class_] of Object.entries(classes as Record<string, unknown>)) {
        if (typeof class_ !== "string" || !TOOL_CLASSES.includes(class_)) {
          throw new Error(`tool class for ${name} must be read, write, or admin`);
        }
        if (name.length >= 64 - String(m.slug).length) {
          throw new Error(`tool name ${name} too long for namespacing under ${String(m.slug)}`);
        }
      }
    }
  }
  if (Array.isArray(m.triggers)) {
    for (const raw of m.triggers) {
      const t = raw as { kind?: unknown; prompt?: unknown; model?: unknown };
      if (t.kind !== "webhook" && t.kind !== "interval") {
        throw new Error("trigger kind must be webhook or interval");
      }
      if (typeof t.prompt !== "string" || t.prompt === "") throw new Error("trigger prompt is empty");
      if (typeof t.model !== "string" || t.model === "") throw new Error("trigger model is empty");
    }
  }
}

/** Effective manifest class for one tool: write, admin, or read (default
 *  for undeclared tools). */
export function toolClass(m: Manifest, tool: string): string {
  const classes = m.tools?.classes;
  if (classes !== null && classes !== undefined && typeof classes === "object") {
    const c = (classes as Record<string, unknown>)[tool];
    if (typeof c === "string") {
      return c === "write" ? "write" : c === "admin" ? "admin" : "read";
    }
  }
  return "read";
}
