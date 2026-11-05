// Images in agent content (Generated UI and chat markdown). A Guild
// attachment (`attachment:<id>` or its API path), read with the session and
// shown as a blob URL, and an inline `data:image/…` URL always load. A
// remote http(s) URL follows the org's policy (Settings → Security): load
// at once, load on a click, or never; it is requested without a referrer.
// Whoever serves a remote image sees the request, URL included, so an
// injected URL can carry data out — the policy is the admin's trade-off.
// Anything else shows the alt text.

import { useEffect, useState } from "react";
import { ImageIcon, ImageOff } from "lucide-react";
import { attachmentBlobUrl } from "../../lib/api/chats";
import { useWorkspaceIdentity } from "../../lib/workspace-store";

type Source =
  | { kind: "attachment"; id: string }
  | { kind: "inline"; url: string }
  | { kind: "remote"; url: string }
  | { kind: "none" };

const ATTACHMENT_PATH = /^\/api\/v1\/attachments\/([0-9a-f-]{36})$/i;

/** Where an image `src` loads from. */
export function imageSource(src: string | undefined | null): Source {
  const s = (src ?? "").trim();
  if (s.startsWith("attachment:")) {
    const id = s.slice("attachment:".length).trim();
    return /^[0-9a-f-]{36}$/i.test(id) ? { kind: "attachment", id } : { kind: "none" };
  }
  const path = ATTACHMENT_PATH.exec(s);
  if (path) return { kind: "attachment", id: path[1]! };
  if (/^data:image\/[a-z0-9.+-]+[;,]/i.test(s)) return { kind: "inline", url: s };
  if (/^https?:\/\//i.test(s)) return { kind: "remote", url: s };
  return { kind: "none" };
}

/** The URL an `<img>` can load for `src`, or null while an attachment is
 *  being read (or cannot be). */
function useImageUrl(src: string | undefined | null): { url: string | null; failed: boolean } {
  const source = imageSource(src);
  const key = source.kind === "attachment" ? source.id : source.kind === "none" ? "" : source.url;
  const [blob, setBlob] = useState<{ id: string; url: string | null } | null>(null);
  const attachmentId = source.kind === "attachment" ? key : null;
  useEffect(() => {
    if (attachmentId === null) return;
    let live = true;
    let made: string | null = null;
    void attachmentBlobUrl(attachmentId).then((url) => {
      made = url;
      if (live) setBlob({ id: attachmentId, url });
      else if (url) URL.revokeObjectURL(url);
    });
    return () => {
      live = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [attachmentId]);
  if (source.kind === "inline" || source.kind === "remote") return { url: source.url, failed: false };
  if (source.kind === "attachment") {
    if (blob?.id !== source.id) return { url: null, failed: false };
    return { url: blob.url, failed: blob.url === null };
  }
  return { url: null, failed: true };
}

export function ContentImage({
  src,
  alt,
  className,
}: {
  src: string | undefined | null;
  alt?: string;
  className?: string;
}) {
  const { url, failed } = useImageUrl(src);
  const policy = useWorkspaceIdentity()?.remote_images ?? "auto";
  const remote = imageSource(src).kind === "remote";
  const [broken, setBroken] = useState(false);
  const [allowed, setAllowed] = useState(false);
  useEffect(() => {
    setBroken(false);
    setAllowed(false);
  }, [url]);
  const host = remote && url ? hostOf(url) : "";
  if (remote && policy === "never") {
    return (
      <span
        className={`inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground ${className ?? ""}`}
        title={`Remote images are off in this workspace (${host})`}
      >
        <ImageOff className="size-3.5 shrink-0" aria-hidden />
        {alt || "Image"} · {host}
      </span>
    );
  }
  if (remote && policy === "click" && !allowed) {
    return (
      <button
        type="button"
        onClick={() => setAllowed(true)}
        className={`inline-flex items-center gap-1.5 rounded-md border border-dashed border-border px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground ${className ?? ""}`}
        title={url ?? undefined}
      >
        <ImageIcon className="size-3.5 shrink-0" aria-hidden />
        Load image{alt ? `: ${alt}` : ""} · {host}
      </button>
    );
  }
  if (failed || broken) {
    return (
      <span
        className={`inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground ${className ?? ""}`}
        title={src ?? undefined}
      >
        <ImageOff className="size-3.5 shrink-0" aria-hidden />
        {alt || "Image unavailable"}
      </span>
    );
  }
  if (url === null) {
    return (
      <span className={`block animate-pulse rounded-md bg-muted ${className ?? "h-40 w-full"}`} aria-label={alt} />
    );
  }
  return (
    <img
      src={url}
      alt={alt ?? ""}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setBroken(true)}
      className={className}
    />
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
