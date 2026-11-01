import type { TSchema } from "@earendil-works/pi-ai";
import type { JsonValue } from "@earendil-works/chord";

/** External schemas enter the typed registry through this validation seam. */
export function toolSchema(value: unknown): TSchema {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("tool input schema must be an object");
  const schema = value as Record<string, unknown>;
  if (schema.type !== "object") throw new Error("tool input schema must have type object");
  if (
    schema.properties !== undefined &&
    (!schema.properties || typeof schema.properties !== "object" || Array.isArray(schema.properties))
  )
    throw new Error("invalid schema properties");
  return schema as TSchema;
}

/** Reject non-JSON metadata before it crosses the durable result seam. */
export function toolDetails(value: unknown): JsonValue {
  const visit = (item: unknown): void => {
    if (item === null || typeof item === "string" || typeof item === "boolean") return;
    if (typeof item === "number" && Number.isFinite(item)) return;
    if (Array.isArray(item)) {
      item.forEach(visit);
      return;
    }
    if (typeof item === "object" && item && Object.getPrototypeOf(item) === Object.prototype) {
      Object.values(item).forEach(visit);
      return;
    }
    throw new Error("tool metadata must be JSON");
  };
  visit(value);
  return value as JsonValue;
}

/** A typed result object as a tool's structured output. The static type
 *  guarantees an object; its fields are JSON by construction (rows, ids and
 *  strings the tool built). */
export function structured<T extends object>(value: T): JsonValue {
  return value as unknown as JsonValue;
}
