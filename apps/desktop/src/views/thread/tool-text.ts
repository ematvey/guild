// Pure text derivations for tool blocks: kind, display name, request preview,
// durations and URL safety. The widgets themselves live in tool-blocks.tsx.
import { artifactCardOf, type ToolBlock } from "../../lib/thread-reducer";

/// Human-facing tool kind: drives the frame icon and widget selection.
export function toolKind(t: ToolBlock): string {
  if (t.kind === "web_search") return "search";
  if (t.kind === "web_browse") return "fetch";
  if (artifactCardOf(t)) return "artifact";
  if (t.meta?.kind) return t.meta.kind;
  if (typeof t.meta?.card === "string") return t.meta.card;
  const n = t.name.toLowerCase();
  if (n === "codemode") return "codemode";
  if (n.includes("search")) return "search";
  if (n.includes("fetch")) return "fetch";
  if (n === "execute" || n === "bash" || n === "shell") return "terminal";
  if (n === "read_file" || n === "read") return "read";
  if (n === "edit_file" || n === "write_file" || n === "edit" || n === "write") return "diff";
  return "other";
}

/// Human-facing tool names (collapsed header): raw wire names like
/// `web_search` stay in the log.
const TOOL_LABELS: Record<string, string> = {
  web_search: "Web search",
  web_fetch: "Browse",
  codemode: "Script",
  execute: "Execute",
  read_file: "Read",
  edit_file: "Edit",
  write_file: "Write",
  // pre-rename wire names, kept so old thread history renders
  bash: "Execute",
  shell: "Execute",
  read: "Read",
  edit: "Edit",
  write: "Write",
};

/**
 * Label for a bare wire tool name (exported for pure tests; approval cards
 * and tool frames must render the same tool identically). The connector
 * slug stays in the label — the wire name is what the model was offered,
 * and the prefix is part of the tool's identity, not noise to assume away.
 */
export function toolDisplayName(name: string): string {
  const n = name.toLowerCase();
  const direct = TOOL_LABELS[n];
  if (direct) return direct;
  // Legacy journals recorded the `int_` marker (`int_searxng_web_search`):
  // dead plumbing, strip it so old threads render like new ones. The slug
  // itself is kept.
  const bare = n.startsWith("int_") ? n.slice(4) : n;
  for (const [key, label] of Object.entries(TOOL_LABELS)) {
    if (bare.endsWith(`_${key}`)) return label;
  }
  return bare.replace(/_/g, " ");
}

/** Exposed for pure tests. */
export function toolLabel(t: ToolBlock): string {
  // Top-level tool kind wins: web_search/web_browse render natively no
  // matter which integration provides the tool.
  if (t.kind === "web_search") return "Web search";
  if (t.kind === "web_browse") return "Browse";
  // Older events without a persisted kind: the widget meta kind maps the
  // same way for web tools.
  if (t.meta?.kind === "search") return "Web search";
  if (t.meta?.kind === "fetch") return "Browse";
  return toolDisplayName(t.name);
}

export function argOf(t: ToolBlock, keys: string[]): string | undefined {
  try {
    const a = JSON.parse(t.args);
    for (const k of keys) {
      const v = a?.[k];
      if (typeof v === "string" && v) return v;
    }
  } catch {
    /* args are not always JSON */
  }
  return undefined;
}

/// The machine a call names, if any: the frame says where the call ran. The
/// argument is a machine id or a label, and the frame resolves it against the
/// registry, so an id never reaches the reader.
export function machineTargetOf(t: ToolBlock): string | undefined {
  return argOf(t, ["machine"]);
}

/// Request text shown on the frame header line (same line as the tool
/// name): search → query, fetch → URL, execute → command, read/edit → path.
export function toolPreview(t: ToolBlock): string | undefined {
  const m = t.meta;
  switch (toolKind(t)) {
    case "search":
      return m?.title || argOf(t, ["query", "q", "search"]);
    case "fetch":
      return m?.url || argOf(t, ["url"]);
    case "terminal":
      return m?.title || argOf(t, ["command", "cmd", "script"]);
    case "read":
    case "diff":
      return m?.path || argOf(t, ["path", "file_path", "file"]);
    case "artifact":
      return artifactCardOf(t)?.filename;
    default:
      return m?.title || undefined;
  }
}

/// Fallback for search results arriving WITHOUT persisted meta (older
/// events): parses the numbered "N. Title / URL / snippet…" list the server
/// composes into source cards.
export function parseSearchResults(content: string): { url: string; title?: string; snippet?: string }[] {
  const out: { url: string; title?: string; snippet?: string }[] = [];
  let cur: { url: string; title?: string; snippet?: string } | null = null;
  for (const l of content.split("\n")) {
    const line = l.trim();
    const tMatch = line.match(/^\d+\.\s+(.*)$/);
    const uMatch = line.match(/^https?:\/\/\S+$/);
    if (tMatch) {
      if (cur) out.push(cur);
      cur = { url: "", title: tMatch[1].trim() };
    } else if (uMatch && cur) {
      cur.url = line;
    } else if (cur && line && !cur.url) {
      cur.title = `${cur.title} ${line}`;
    } else if (cur && line) {
      cur.snippet = cur.snippet ? `${cur.snippet} ${line}` : line;
    }
  }
  if (cur) out.push(cur);
  return out.filter((r) => r.url);
}

/// Wall-clock label for a codemode nested-call row: `340ms` / `1.2s`.
export function codemodeDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(Math.round(ms / 100) / 10).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}

/**
 * Tool-result metadata is attacker-influenced; only http(s) URLs may become
 * link targets. Anything else (javascript:, data:, malformed text) renders
 * as plain text instead of an anchor.
 */
export function safeUrl(raw: string | undefined | null): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}
