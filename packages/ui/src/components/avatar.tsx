//! Avatar: the user/owner photo chip used wherever an avatar renders —
//! account badges, skill owner rows, activity actors. Renders the image
//! when a URL is set and loads; a missing URL or a failed load falls back
//! to the caller's initials node. Size, border and color variants come
//! from the caller's classes.

import { useEffect, useState } from "react";

import { cn } from "../lib/utils";

export function Avatar({
  src,
  alt = "",
  fallback,
  className,
  fallbackClassName,
}: {
  /** The image URL; null/undefined renders the fallback. */
  src?: string | null;
  alt?: string;
  /** Initials (or any node) shown when there is no image or it failed. */
  fallback: React.ReactNode;
  /** Size and shape classes, applied to image and fallback alike. */
  className?: string;
  /** Color/typography classes for the fallback chip only. */
  fallbackClassName?: string;
}) {
  const [broken, setBroken] = useState(false);
  // A changed URL may load fine — clear the broken flag for the new source.
  useEffect(() => setBroken(false), [src]);
  const showImage = src != null && src !== "" && !broken;
  if (showImage) {
    return (
      <img
        src={src}
        alt={alt}
        referrerPolicy="no-referrer"
        onError={() => setBroken(true)}
        className={cn("shrink-0 rounded-full object-cover", className)}
      />
    );
  }
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full",
        className,
        fallbackClassName,
      )}
    >
      {fallback}
    </span>
  );
}
