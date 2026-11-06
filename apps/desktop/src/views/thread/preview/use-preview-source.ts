// The preview pane's sources: one blob URL per file, minted from an authed
// fetch, plus the metadata the header needs. A file is named by the address
// (`?preview=<kind>:<id>`), so a reload reopens the same file; the filename
// and content type come from the thread when the file is on screen, else from
// the response itself.
import { useEffect, useState } from "react";
import { requestResponse } from "../../../lib/api/request";
import type { PreviewRef } from "../route";

export interface PreviewSource {
  kind: PreviewRef["kind"];
  id: string;
  filename: string;
  contentType: string;
  /** Object URL of the bytes; null while loading or when the read failed. */
  url: string | null;
  /** The signed same-origin URL a frame loads. A frame cannot send the
   *  Authorization header, and the app's CSP lets a frame load only 'self'
   *  and blob, so this is how HTML and PDF reach the pane. */
  link: string | null;
  failed: boolean;
}

/** Metadata the thread already knows about a file (an attachment chip, an
 *  artifact card). */
export interface PreviewMeta {
  filename: string;
  contentType: string;
}

/** Fetches the bytes as a blob URL and keeps its metadata. `meta` fills the
 *  name and type when the caller has them; otherwise the response headers
 *  do. */
export function usePreviewSource(ref: PreviewRef | null, meta: PreviewMeta | undefined): PreviewSource | null {
  const [source, setSource] = useState<PreviewSource | null>(null);
  useEffect(() => {
    if (ref === null) {
      setSource(null);
      return;
    }
    let dead = false;
    let minted: string | null = null;
    const path = ref.kind === "attachment" ? `/api/v1/attachments/${ref.id}` : `/api/v1/tool_artifacts/${ref.id}`;
    setSource({
      kind: ref.kind,
      id: ref.id,
      filename: meta?.filename ?? "Preview",
      contentType: meta?.contentType ?? "",
      url: null,
      link: null,
      failed: false,
    });
    void (async () => {
      try {
        const res = await requestResponse("GET", path);
        const contentType = meta?.contentType ?? (res.headers.get("content-type") ?? "");
        const disposition = res.headers.get("content-disposition") ?? "";
        // The server names the file in RFC 5987 form; the ASCII fallback is
        // the second choice.
        const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
        const plain = /filename="([^"]*)"/i.exec(disposition)?.[1];
        const filename = meta?.filename ?? (utf8 !== undefined ? decodeURIComponent(utf8) : (plain ?? "Preview"));
        minted = URL.createObjectURL(await res.blob());
        if (dead) {
          URL.revokeObjectURL(minted);
          return;
        }
        const link = await previewLink(ref.kind, ref.id);
        if (dead) return;
        setSource({ kind: ref.kind, id: ref.id, filename, contentType, url: minted, link, failed: false });
      } catch {
        if (!dead)
          setSource({
            kind: ref.kind,
            id: ref.id,
            filename: meta?.filename ?? "Preview",
            contentType: "",
            url: null,
            link: null,
            failed: true,
          });
      }
    })();
    return () => {
      dead = true;
      if (minted !== null) URL.revokeObjectURL(minted);
    };
  }, [ref?.kind, ref?.id, meta?.filename, meta?.contentType]);
  return source;
}

/** The signed URL the server mints for a frame; null when it cannot. */
async function previewLink(kind: PreviewRef["kind"], id: string): Promise<string | null> {
  try {
    const res = await requestResponse("GET", `/api/v1/preview_link?kind=${kind}&id=${encodeURIComponent(id)}`);
    const body = (await res.json()) as { path?: unknown };
    return typeof body.path === "string" ? body.path : null;
  } catch {
    return null;
  }
}

/** What the viewer renders for a content type. */
export type PreviewView = "html" | "pdf" | "image" | "text" | "binary";

export function previewViewOf(contentType: string, filename: string): PreviewView {
  const ct = contentType.toLowerCase();
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  if (ct.startsWith("image/")) return "image";
  if (ct === "application/pdf" || ext === "pdf") return "pdf";
  if (ct === "text/html" || ext === "html" || ext === "htm") return "html";
  if (ct.startsWith("text/") || ct === "application/json" || ct === "application/xml") return "text";
  if (ext === "md" || ext === "csv" || ext === "txt" || ext === "json") return "text";
  return "binary";
}
