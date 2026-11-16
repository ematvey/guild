// The tool risk class vocabulary: read, write, admin. One home for the
// class rank, the compiled-in class rule, and the client
// tool names that map into the policy vocabulary.

export type ToolClass = "read" | "write" | "admin";

export const TOOL_CLASSES: readonly ToolClass[] = ["read", "write", "admin"];

export function isToolClass(value: unknown): value is ToolClass {
  return value === "read" || value === "write" || value === "admin";
}

/** Class rank for the policy rule: read < write < admin. */
export function classRank(cls: string): number {
  return cls === "write" ? 1 : cls === "admin" ? 2 : 0;
}

/** Effective manifest class for one compiled-in tool: the declared class or
 *  read. */
export function toolClassOf(connector: { classes: Record<string, string> }, tool: string): string {
  const declared = connector.classes[tool];
  if (declared === "write" || declared === "admin") return declared;
  return "read";
}

/** The pi-durable tool names → the guild-core tool classes the client
 *  policy vocabulary is keyed by. */
export function clientToolClass(name: string): string {
  switch (name) {
    case "read":
      return "read_file";
    case "bash":
      return "execute";
    case "write":
      return "write_file";
    case "edit":
      return "edit_file";
    default:
      return name;
  }
}
