// Tool-artifact spill: oversized
// tool results become a tool_artifacts row + object-storage bytes, and the
// persisted tool_result event carries a short pointer text naming the
// materialized path `.guild/artifacts/<chat>/<filename>` instead of the full
// content. The spill rides the bridge's event-append boundary
// (thread_events derive from durable entries) and is
// idempotent — deterministic uuid v5 + ON CONFLICT DO NOTHING, so replays
// and re-executions reuse the row. A spill failure keeps the inline result:
// the outcome is never lost.

import { ApiError } from "../platform/errors.js";
import type { ObjectStore } from "../platform/s3.js";
import { safeFilename } from "../platform/store/attachments.js";
import {
  artifactUuid,
  type ToolArtifactStore,
  toolArtifactObjectKey,
  type ToolArtifactRow,
} from "../platform/store/tool-artifacts.js";
import { isTextual } from "../platform/domain/mime.js";

/** Serialized model-facing content above this size spills into an artifact
 *  (one shared threshold for every server-side tool). */
export const SPILL_THRESHOLD_BYTES = 64 * 1024;

/** Head excerpt kept inline for spilled text results. */
export const EXCERPT_BYTES = 2048;

/** Model-facing workspace path prefix for materialized artifacts. */
export const ARTIFACT_DIR = ".guild/artifacts";

export interface SpilledArtifact {
  artifact_id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  /** Relative model-facing path: `.guild/artifacts/{chat_id}/{filename}`. */
  path: string;
}

export function shouldSpill(content: string): boolean {
  return Buffer.byteLength(content, "utf8") > SPILL_THRESHOLD_BYTES;
}

/** KiB rounding for the "(first 2 KiB of N KiB)" marker — a 1-byte spill
 *  reads "of 1 KiB", never "of 0 KiB". */
export function sizeKiB(sizeBytes: number): number {
  return Math.max(1, Math.ceil(sizeBytes / 1024));
}

function formatSize(sizeBytes: number): string {
  if (sizeBytes >= 1024 * 1024) return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(sizeBytes / 1024).toFixed(1)} KiB`;
}

/** Model-facing pointer text for a spilled result.
 *
 *  Text mime: one line naming tool/filename/size, then the explicit marker
 *  and the first 2 KiB excerpt. Binary mime: one line with path, size and
 *  mime only. This exact shape is contract for the model-facing history. */
export function pointerText(
  toolName: string,
  spilled: SpilledArtifact,
  contentType: string,
  fullText: string | null,
): string {
  const head = `Tool "${toolName}" returned a large result saved as ${spilled.filename} (${formatSize(spilled.size_bytes)} — ${spilled.size_bytes} bytes, ${contentType}).`;
  if (fullText !== null && isTextual(contentType)) {
    const excerpt = [...fullText].slice(0, EXCERPT_BYTES).join("");
    return `${head}\nFirst 2 KiB of ${sizeKiB(spilled.size_bytes)} KiB; full result at ${spilled.path}:\n${excerpt}`;
  }
  return `${head} Full result at ${spilled.path}.`;
}

/** The `meta` payload a spilled ToolResult carries so clients can render the
 *  download card: existing tool meta keys are preserved, `card` is claimed
 *  by the artifact card, and the artifact keys are exact contract for the
 *  client/UI lanes. */
export function artifactMeta(existing: unknown, spilled: SpilledArtifact): Record<string, unknown> {
  const obj: Record<string, unknown> =
    typeof existing === "object" && existing !== null && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};
  obj["card"] = "artifact";
  obj["id"] = spilled.artifact_id;
  obj["filename"] = spilled.filename;
  obj["content_type"] = spilled.content_type;
  obj["size_bytes"] = spilled.size_bytes;
  obj["path"] = spilled.path;
  return obj;
}

function spilledFromRow(row: ToolArtifactRow): SpilledArtifact {
  return {
    artifact_id: row.id,
    filename: row.filename,
    content_type: row.content_type,
    size_bytes: row.size_bytes,
    path: `${ARTIFACT_DIR}/${row.chat_id}/${row.filename}`,
  };
}

/** Creates (or reuses) the artifact row and object bytes for one tool
 *  result, resolving the filename collision rule: when the same filename
 *  already exists in the chat under a different artifact, the materialized
 *  filename is prefixed with a short id segment (deterministic — the
 *  segment derives from the fixed artifact id, so a replay re-derives the
 *  same materialized name). */
export async function spillArtifact(
  artifacts: ToolArtifactStore,
  objects: ObjectStore,
  orgId: string,
  chatId: string,
  callId: string,
  toolName: string,
  filename: string,
  contentType: string,
  bytes: Buffer,
): Promise<SpilledArtifact> {
  const artifactId = artifactUuid(chatId, callId);
  // Replay fast path: the artifact of this call already exists.
  try {
    return spilledFromRow(await artifacts.get(orgId, artifactId));
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 404) throw error;
  }
  let safe = safeFilename(filename) ?? "artifact.bin";
  // Collision rule: same filename under a different artifact in this chat
  // gets an id-prefix.
  const existing = await artifacts.listForChat(orgId, chatId);
  if (existing.some((row) => row.filename === safe)) {
    const seg = artifactId.replaceAll("-", "").slice(0, 8);
    safe = `${seg}_${safe}`;
  }
  const key = toolArtifactObjectKey(orgId, artifactId, safe);
  await objects.put(key, bytes);
  const row = await artifacts.create(artifactId, orgId, chatId, safe, contentType, bytes.length, key, toolName, callId);
  return spilledFromRow(row);
}

/** Spills an oversized plain-text tool result and returns the descriptor
 *  plus the pointer text (2 KiB head excerpt inline, full result at the
 *  materialized path). The bridge's boundary for every tool result. */
export async function spillOversizedResult(
  artifacts: ToolArtifactStore,
  objects: ObjectStore,
  orgId: string,
  chatId: string,
  callId: string,
  toolName: string,
  raw: string,
): Promise<{ spilled: SpilledArtifact; pointer: string }> {
  const spilled = await spillArtifact(
    artifacts,
    objects,
    orgId,
    chatId,
    callId,
    toolName,
    `${toolName}_result.txt`,
    "text/plain; charset=utf-8",
    Buffer.from(raw, "utf8"),
  );
  const pointer = pointerText(toolName, spilled, "text/plain; charset=utf-8", raw);
  return { spilled, pointer };
}
