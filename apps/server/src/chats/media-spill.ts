// The write side of a media reference: a tool result's image parts are
// stored as tool artifacts and replaced by references before the result is
// recorded (platform/media-ref.ts holds the format and the resolver).

import type { ObjectStore } from "../platform/s3.js";
import type { ToolArtifactStore } from "../platform/store/tool-artifacts.js";
import { isImagePart, mediaRefOf, parseMediaRef, type ImagePart } from "../platform/media-ref.js";
import { spillArtifact, type SpilledArtifact } from "./spill.js";

/** Where a spill writes and what it names the rows: one tool call in one
 *  chat. */
export interface SpillScope {
  orgId: string;
  chatId: string;
  callId: string;
  toolName: string;
}

export interface SpillStores {
  artifacts: ToolArtifactStore;
  objects: ObjectStore;
}

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
};

/** Stores one image part's bytes and returns the part that stands in for it.
 *  The call id gains an index so several images of one call get distinct,
 *  deterministic rows: a replay re-derives the same references. */
async function spillOne(
  stores: SpillStores,
  scope: SpillScope,
  part: ImagePart,
  index: number,
): Promise<ImagePart & { spilled: SpilledArtifact }> {
  const ext = EXTENSIONS[part.mimeType] ?? "bin";
  const spilled = await spillArtifact(
    stores.artifacts,
    stores.objects,
    scope.orgId,
    scope.chatId,
    `${scope.callId}#${index}`,
    scope.toolName,
    `${scope.toolName}_image_${index}.${ext}`,
    part.mimeType,
    Buffer.from(part.data, "base64"),
  );
  return { ...part, data: mediaRefOf("artifact", spilled.artifact_id), spilled };
}

/** Replaces every image part of one tool result with its reference. Parts
 *  that already carry a reference pass through untouched (a replayed result
 *  re-derives the same rows), and text parts are returned as they are. */
export async function spillImageParts<T extends { type: string }>(
  stores: SpillStores,
  scope: SpillScope,
  parts: readonly T[],
): Promise<{ parts: T[]; spilled: SpilledArtifact[] }> {
  const out: T[] = [];
  const spilled: SpilledArtifact[] = [];
  let index = 0;
  for (const part of parts) {
    if (!isImagePart(part) || parseMediaRef(part.data) !== null) {
      out.push(part);
      continue;
    }
    const stored = await spillOne(stores, scope, part, index++);
    spilled.push(stored.spilled);
    out.push(stored as unknown as T);
  }
  return { parts: out, spilled };
}
