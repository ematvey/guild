// App data functions (docs/domain/004-capabilities.md, "Apps"): the only way
// an App's page reaches an Integration. Each function names one Integration
// tool, fixes its arguments, and leaves holes (`{"$param": "<name>"}`) for
// typed, bounded parameters the page fills in. The page never chooses the
// tool or the shape of its arguments, so a reader of the manifest knows
// every call the App can make.

/** A JSON object of tool arguments. */
export type JsonObject = { [key: string]: unknown };

export type AppParamType = "string" | "number" | "integer" | "boolean";

/** One parameter a page may pass to a data function. */
export interface AppParam {
  type: AppParamType;
  description?: string;
  /** The allowed values; any other value is refused. */
  enum?: (string | number)[];
  /** Used when the page omits the parameter. */
  default?: string | number | boolean;
  /** A required parameter without a default must be passed. */
  required?: boolean;
  /** Strings only. */
  max_length?: number;
  /** Numbers only. */
  minimum?: number;
  maximum?: number;
}

/** One named data function of an App. */
export interface AppFunction {
  name: string;
  description: string;
  /** The Integration's slug. */
  integration: string;
  /** The tool's name as `<slug>_list_tools` shows it (the raw name works too). */
  tool: string;
  /** The tool's arguments; `{"$param": "<name>"}` marks a parameter's place. */
  args: JsonObject;
  params: Record<string, AppParam>;
}

export const MAX_APP_FUNCTIONS = 32;
export const MAX_APP_PARAMS = 16;
export const MAX_ARGS_BYTES = 16 * 1024;
export const DEFAULT_MAX_LENGTH = 1_000;
const NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;
const TYPES: readonly AppParamType[] = ["string", "number", "integer", "boolean"];

export class AppFunctionError extends Error {}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The placeholder's parameter name, or null when the value is not one. */
function placeholder(value: unknown): string | null {
  if (!isObject(value)) return null;
  const keys = Object.keys(value);
  return keys.length === 1 && keys[0] === "$param" && typeof value["$param"] === "string" ? value["$param"] : null;
}

/** Every parameter name the arguments refer to. */
function referencedParams(value: unknown, out: Set<string>): Set<string> {
  const name = placeholder(value);
  if (name !== null) out.add(name);
  else if (Array.isArray(value)) for (const item of value) referencedParams(item, out);
  else if (isObject(value)) for (const item of Object.values(value)) referencedParams(item, out);
  return out;
}

function parseParam(fn: string, name: string, raw: unknown): AppParam {
  if (!NAME_RE.test(name)) throw new AppFunctionError(`${fn}: parameter name "${name}" must match ${NAME_RE}`);
  if (!isObject(raw)) throw new AppFunctionError(`${fn}.${name}: must be an object`);
  const type = raw["type"];
  if (!TYPES.includes(type as AppParamType)) {
    throw new AppFunctionError(`${fn}.${name}: type must be one of ${TYPES.join(", ")}`);
  }
  const param: AppParam = { type: type as AppParamType };
  if (typeof raw["description"] === "string") param.description = raw["description"].slice(0, 500);
  if (raw["enum"] !== undefined) {
    const values = raw["enum"];
    if (!Array.isArray(values) || values.length === 0 || values.length > 200) {
      throw new AppFunctionError(`${fn}.${name}: enum must be a non-empty list of at most 200 values`);
    }
    param.enum = values.map((value) => {
      if (typeof value !== "string" && typeof value !== "number") {
        throw new AppFunctionError(`${fn}.${name}: enum values must be strings or numbers`);
      }
      return value;
    });
  }
  if (raw["required"] === true) param.required = true;
  for (const key of ["max_length", "minimum", "maximum"] as const) {
    const value = raw[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new AppFunctionError(`${fn}.${name}: ${key} must be a number`);
    }
    param[key] = value;
  }
  if (raw["default"] !== undefined) {
    param.default = checkValue(`${fn}.${name}`, param, raw["default"]);
  }
  return param;
}

/** Parses and checks one App's function manifest. */
export function parseAppFunctions(raw: unknown): AppFunction[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new AppFunctionError("functions must be a list");
  if (raw.length > MAX_APP_FUNCTIONS) throw new AppFunctionError(`at most ${MAX_APP_FUNCTIONS} functions`);
  const seen = new Set<string>();
  return raw.map((item, index) => {
    if (!isObject(item)) throw new AppFunctionError(`functions[${index}] must be an object`);
    const name = item["name"];
    if (typeof name !== "string" || !NAME_RE.test(name)) {
      throw new AppFunctionError(`functions[${index}].name must match ${NAME_RE}`);
    }
    if (seen.has(name)) throw new AppFunctionError(`function ${name} is declared twice`);
    seen.add(name);
    const integration = item["integration"];
    const tool = item["tool"];
    if (typeof integration !== "string" || integration === "") {
      throw new AppFunctionError(`${name}: integration must name an Integration slug`);
    }
    if (typeof tool !== "string" || tool === "") throw new AppFunctionError(`${name}: tool must name a tool`);
    const args = item["args"] ?? {};
    if (!isObject(args)) throw new AppFunctionError(`${name}: args must be an object`);
    if (Buffer.byteLength(JSON.stringify(args)) > MAX_ARGS_BYTES) {
      throw new AppFunctionError(`${name}: args are larger than ${MAX_ARGS_BYTES} bytes`);
    }
    const rawParams = item["params"] ?? {};
    if (!isObject(rawParams)) throw new AppFunctionError(`${name}: params must be an object`);
    const entries = Object.entries(rawParams);
    if (entries.length > MAX_APP_PARAMS) throw new AppFunctionError(`${name}: at most ${MAX_APP_PARAMS} params`);
    const params: Record<string, AppParam> = {};
    for (const [key, value] of entries) params[key] = parseParam(name, key, value);
    for (const used of referencedParams(args, new Set())) {
      if (params[used] === undefined) throw new AppFunctionError(`${name}: args use undeclared parameter "${used}"`);
    }
    const description = typeof item["description"] === "string" ? item["description"].slice(0, 500) : "";
    return { name, description, integration, tool, args: args as JsonObject, params };
  });
}

/** Checks one value against its parameter; returns the value to bind. */
function checkValue(label: string, param: AppParam, value: unknown): string | number | boolean {
  switch (param.type) {
    case "boolean":
      if (typeof value !== "boolean") throw new AppFunctionError(`${label} must be a boolean`);
      return value;
    case "string": {
      if (typeof value !== "string") throw new AppFunctionError(`${label} must be a string`);
      const max = param.max_length ?? DEFAULT_MAX_LENGTH;
      if (value.length > max) throw new AppFunctionError(`${label} is longer than ${max} characters`);
      if (param.enum !== undefined && !param.enum.includes(value)) {
        throw new AppFunctionError(`${label} must be one of ${param.enum.join(", ")}`);
      }
      return value;
    }
    case "number":
    case "integer": {
      if (typeof value !== "number" || !Number.isFinite(value)) throw new AppFunctionError(`${label} must be a number`);
      if (param.type === "integer" && !Number.isInteger(value)) {
        throw new AppFunctionError(`${label} must be an integer`);
      }
      if (param.minimum !== undefined && value < param.minimum) {
        throw new AppFunctionError(`${label} must be at least ${param.minimum}`);
      }
      if (param.maximum !== undefined && value > param.maximum) {
        throw new AppFunctionError(`${label} must be at most ${param.maximum}`);
      }
      if (param.enum !== undefined && !param.enum.includes(value)) {
        throw new AppFunctionError(`${label} must be one of ${param.enum.join(", ")}`);
      }
      return value;
    }
  }
}

/** The tool arguments one call binds: every placeholder replaced by its
 *  checked value. A placeholder of an omitted optional parameter drops its
 *  object key or array slot. Unknown parameters are refused. */
export function bindAppFunction(fn: AppFunction, given: unknown): JsonObject {
  const values = given === undefined || given === null ? {} : given;
  if (!isObject(values)) throw new AppFunctionError("params must be an object");
  for (const key of Object.keys(values)) {
    if (fn.params[key] === undefined) throw new AppFunctionError(`${fn.name} has no parameter "${key}"`);
  }
  const bound = new Map<string, string | number | boolean>();
  for (const [name, param] of Object.entries(fn.params)) {
    const value = values[name];
    if (value === undefined || value === null) {
      if (param.default !== undefined) bound.set(name, param.default);
      else if (param.required === true) throw new AppFunctionError(`${fn.name}: parameter "${name}" is required`);
      continue;
    }
    bound.set(name, checkValue(`${fn.name}.${name}`, param, value));
  }
  const OMIT = Symbol("omit");
  const fill = (value: unknown): unknown => {
    const name = placeholder(value);
    if (name !== null) return bound.has(name) ? bound.get(name) : OMIT;
    if (Array.isArray(value)) return value.map(fill).filter((item) => item !== OMIT);
    if (isObject(value)) {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) {
        const filled = fill(item);
        if (filled !== OMIT) out[key] = filled;
      }
      return out;
    }
    return value;
  };
  return fill(fn.args) as JsonObject;
}
