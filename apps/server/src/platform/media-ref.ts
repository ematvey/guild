// Media references: the one way image bytes relate to a durable entry.
//
// The rule is that no blob lives in the database. A tool result or a member
// message that carries an image keeps a reference — `guild-media:<store>:<id>`
// in the image part's `data` — and the bytes stay in object storage (a tool
// artifact or an attachment row). The model request resolves the reference
// back to a data URI at call time, through a process cache, because every
// step of a turn resends the whole history and the same images with it.
//
// The reference travels inside the image part's `data` field, so the part
// keeps its shape: pi-durable records it, the token estimator counts it as
// one image, and the provider adapters see `data:<mime>;base64,<ref>` — the
// exact shape they already parse.

import type { ObjectStore } from "./s3.js";
import type { AttachmentStore } from "./store/attachments.js";
import { attachmentObjectKey } from "./store/attachments.js";
import type { ToolArtifactStore } from "./store/tool-artifacts.js";
import { toolArtifactObjectKey } from "./store/tool-artifacts.js";

/** Prefix of every media reference, inside the image part's `data`. */
export const MEDIA_REF_PREFIX = "guild-media:";

/** The stores a reference can name: a tool artifact (tool output bytes) or
 *  an attachment (a member's upload). */
export type MediaStore = "artifact" | "attachment";

export interface MediaRef {
  store: MediaStore;
  id: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function mediaRefOf(store: MediaStore, id: string): string {
  return `${MEDIA_REF_PREFIX}${store}:${id}`;
}

/** The reference a part's `data` names, bare or inside a data URI
 *  (`data:image/png;base64,guild-media:…`); null for real bytes. */
export function parseMediaRef(data: string): MediaRef | null {
  const at = data.indexOf(MEDIA_REF_PREFIX);
  if (at === -1) return null;
  const rest = data.slice(at + MEDIA_REF_PREFIX.length);
  const sep = rest.indexOf(":");
  if (sep === -1) return null;
  const store = rest.slice(0, sep);
  const id = rest.slice(sep + 1);
  if (store !== "artifact" && store !== "attachment") return null;
  if (!UUID_RE.test(id)) return null;
  return { store, id };
}

/** One image part as pi-durable records it. */
export interface ImagePart {
  type: "image";
  mimeType: string;
  data: string;
}

export function isImagePart(part: unknown): part is ImagePart {
  return (
    typeof part === "object" &&
    part !== null &&
    (part as { type?: unknown }).type === "image" &&
    typeof (part as { data?: unknown }).data === "string" &&
    typeof (part as { mimeType?: unknown }).mimeType === "string"
  );
}

export interface MediaStores {
  objects: ObjectStore;
  artifacts: Pick<ToolArtifactStore, "get">;
  attachments: Pick<AttachmentStore, "get">;
}

/** How much one worker keeps of resolved images. The same screenshots ride
 *  every step of a turn, so the bytes are read once per process, not once
 *  per step. */
const CACHE_MAX_BYTES = 64 * 1024 * 1024;
const CACHE_MAX_ENTRIES = 64;

/** Resolves references to data URIs, caching the bytes per process. */
export class MediaResolver {
  private readonly cache = new Map<string, string>();
  private cachedBytes = 0;

  constructor(
    private readonly stores: MediaStores,
    private readonly limits: { maxBytes?: number; maxEntries?: number } = {},
  ) {}

  /** The data URI for `uri`: references resolve to their bytes, anything
   *  else (a real data URI, an http URL) is returned unchanged. A reference
   *  whose bytes are gone resolves to its own text, so a request fails at
   *  the provider with a clear message instead of silently dropping the
   *  image. */
  async resolve(orgId: string, uri: string): Promise<string> {
    const ref = parseMediaRef(uri);
    if (ref === null) return uri;
    const key = `${orgId}:${ref.store}:${ref.id}`;
    const hit = this.cache.get(key);
    if (hit !== undefined) {
      // Refresh the entry's place in the insertion order.
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit;
    }
    const resolved = await this.read(orgId, ref);
    this.remember(key, resolved);
    return resolved;
  }

  /** Resolves every image of every message; messages without media come
   *  back as the same object. */
  async resolveMessages<T extends { images?: string[] }>(orgId: string, messages: readonly T[]): Promise<T[]> {
    let touched = false;
    const out: T[] = [];
    for (const message of messages) {
      const images = message.images;
      if (images === undefined || images.length === 0 || !images.some((uri) => parseMediaRef(uri) !== null)) {
        out.push(message);
        continue;
      }
      touched = true;
      const resolved: string[] = [];
      for (const uri of images) resolved.push(await this.resolve(orgId, uri));
      out.push({ ...message, images: resolved });
    }
    return touched ? out : (messages as T[]);
  }

  private async read(orgId: string, ref: MediaRef): Promise<string> {
    if (ref.store === "artifact") {
      const row = await this.stores.artifacts.get(orgId, ref.id);
      const bytes = await this.stores.objects.get(toolArtifactObjectKey(row.org_id, row.id, row.filename));
      return dataUri(row.content_type, bytes);
    }
    const row = await this.stores.attachments.get(orgId, ref.id);
    const bytes = await this.stores.objects.get(attachmentObjectKey(row.org_id, row.id, row.filename));
    return dataUri(row.content_type, bytes);
  }

  private remember(key: string, uri: string): void {
    const maxBytes = this.limits.maxBytes ?? CACHE_MAX_BYTES;
    const maxEntries = this.limits.maxEntries ?? CACHE_MAX_ENTRIES;
    this.cache.set(key, uri);
    this.cachedBytes += uri.length;
    while (this.cache.size > maxEntries || (this.cachedBytes > maxBytes && this.cache.size > 1)) {
      const oldest = this.cache.keys().next();
      if (oldest.done === true) break;
      const value = this.cache.get(oldest.value);
      this.cache.delete(oldest.value);
      this.cachedBytes -= value?.length ?? 0;
    }
  }
}

function dataUri(mimeType: string, bytes: Buffer): string {
  return `data:${mimeType};base64,${bytes.toString("base64")}`;
}
