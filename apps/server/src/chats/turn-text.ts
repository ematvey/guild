// Turn derivation: the arrival-turn
// user event text (chips + inlined document bytes), the attachment media
// map, and the model-facing image parts — everything the turn submission
// derives from its inputs before the durable run starts.

import { attachmentObjectKey, type AttachmentRow } from "../platform/store/attachments.js";
import type { ObjectStore } from "../platform/s3.js";
import type { MessageAttachment } from "../platform/domain/thread-events.js";
import { isTextual, modalityOf } from "../platform/domain/mime.js";

/** Loaded attachment bytes for the current turn, wire-ready: base64 plus
 *  the content type (data URIs are derived at use time, gated by the
 *  resolved route's modalities). */
export interface MediaRef {
  mime: string;
  b64: string;
}

export type MediaMap = Map<string, MediaRef>;

/** OpenAI `input_audio` accepts wav/mp3 only. */
function audioFormat(mime: string): string | undefined {
  switch (mime) {
    case "audio/wav":
    case "audio/x-wav":
    case "audio/wave":
      return "wav";
    case "audio/mpeg":
    case "audio/mp3":
      return "mp3";
    default:
      return undefined;
  }
}

/** Model-facing image/audio data URIs for a turn's attachments, gated by
 *  the route's native modalities. Unsupported media stays in the log and in
 *  object storage, never silently deleted — it just does not reach this
 *  model. */
export function mediaParts(
  media: MediaMap,
  atts: readonly MessageAttachment[],
  modalities: readonly string[],
): { images: string[]; audio: { data: string; format: string }[] } {
  const images: string[] = [];
  const audio: { data: string; format: string }[] = [];
  for (const a of atts) {
    const m = media.get(a.id);
    if (!m) continue;
    const supported = modalities.includes(a.modality);
    if (a.modality === "image" && supported) {
      images.push(`data:${m.mime};base64,${m.b64}`);
    } else if (a.modality === "audio" && supported) {
      const f = audioFormat(m.mime);
      if (f) audio.push({ data: m.b64, format: f });
    }
  }
  return { images, audio };
}

/** Inline cap for one document attachment's textual content (chars) — a
 *  single huge file must not blow the context window by itself. */
const ATTACHMENT_INLINE_LIMIT = 80_000;

/** Builds the arrival-turn user event from the requested attachment ids (in
 *  the chat's attachment order): chip metadata plus the text appended to the
 *  typed message (inlined document text, or a note for media). The marker
 *  `"\n\n[Attachment: "` is the UI's strip boundary — clients render the
 *  typed text plus chips, not the wire text. */
export function buildTurnText(
  requested: readonly string[],
  media: MediaMap,
  rows: readonly AttachmentRow[],
  modalities: readonly string[],
): { chips: MessageAttachment[]; inline: string } {
  const chips: MessageAttachment[] = [];
  const blocks: string[] = [];
  for (const row of rows) {
    if (!requested.includes(row.id)) continue;
    const modality = modalityOf(row.content_type);
    chips.push({
      id: row.id,
      filename: row.filename,
      content_type: row.content_type,
      size_bytes: Number(row.size_bytes),
      modality,
    });
    if (modality === "document") {
      let text = media.get(row.id) ? Buffer.from(media.get(row.id)!.b64, "base64").toString("utf-8") : "";
      if (text.length > ATTACHMENT_INLINE_LIMIT) {
        text = Array.from(text).slice(0, ATTACHMENT_INLINE_LIMIT).join("") + "\n…[truncated]";
      }
      if (isTextual(row.content_type, row.filename) && text.length > 0) {
        blocks.push(`[Attachment: ${row.filename} (${row.content_type}, ${row.size_bytes} bytes)]\n${text}`);
      } else {
        blocks.push(`[Attachment: ${row.filename} (${row.content_type}, ${row.size_bytes} bytes) — content not inlined]`);
      }
    } else {
      const supported = modalities.includes(modality);
      const note = supported
        ? modality === "image"
          ? "shown to the model as an image"
          : modality === "audio"
            ? "provided to the model as audio"
            : "no native modality on this route"
        : "stored; this model does not accept this modality";
      blocks.push(`[Attachment: ${row.filename} (${row.content_type}, ${row.size_bytes} bytes) — ${note}]`);
    }
  }
  return { chips, inline: blocks.join("\n\n") };
}

/** Loaded attachment bytes for one chat's turn: every image/audio
 *  attachment referenced (derivation replays them as parts on every
 *  subsequent turn) plus every id in `extraIds` (the arrival turn; documents
 *  need their bytes for inlining). Bytes are immutable once uploaded, so the
 *  read is deterministic. A missing object is tolerated (the row exists, the
 *  upload does not); other read failures propagate — a requested
 *  attachment's bytes are part of the immutable user message. */
export async function loadMediaMap(
  objects: ObjectStore,
  orgId: string,
  rows: readonly AttachmentRow[],
  eventAttachmentIds: readonly string[],
  extraIds: readonly string[],
): Promise<MediaMap> {
  const ids = new Set<string>();
  for (const id of eventAttachmentIds) {
    // Only image/audio attachments ride as parts on later turns; documents
    // are loaded for the arrival turn's inlining via extraIds.
    const row = rows.find((r) => r.id === id);
    if (row && ["image", "audio"].includes(modalityOf(row.content_type))) ids.add(id);
  }
  for (const id of extraIds) ids.add(id);
  const map: MediaMap = new Map();
  if (ids.size === 0) return map;
  for (const row of rows) {
    if (!ids.has(row.id)) continue;
    const key = attachmentObjectKey(orgId, row.id, row.filename);
    try {
      const bytes = await objects.get(key);
      map.set(row.id, { mime: row.content_type, b64: bytes.toString("base64") });
    } catch (error) {
      // A missing object is tolerated (the row exists, the upload does not);
      // any other read failure propagates — the attachment bytes are part of
      // the immutable user message, and silently skipping would permanently
      // strip it from history.
      const name = (error as { name?: string }).name;
      if (name === "NoSuchKey" || name === "NotFound") continue;
      throw error;
    }
  }
  return map;
}
