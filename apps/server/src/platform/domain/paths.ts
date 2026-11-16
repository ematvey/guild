// Destination rules for the file tools: a tool writes where the caller says,
// and never outside the working folder. One rule, shared by the download tool
// and by the integration tools that carry bytes.

/** The destination the caller named, as a path relative to the working
 *  folder, or the reason it is not one. */
export function relativeDestination(path: string): { ok: true; path: string } | { ok: false; reason: string } {
  const raw = path.trim();
  if (raw === "") return { ok: false, reason: "path is required: name the destination file" };
  if (raw.includes("\u0000")) return { ok: false, reason: "path contains a NUL byte" };
  if (raw.startsWith("/") || /^[A-Za-z]:[\\/]/.test(raw)) {
    return { ok: false, reason: "path must be relative to the working folder" };
  }
  const parts: string[] = [];
  for (const part of raw.replaceAll("\\", "/").split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") return { ok: false, reason: "path must not leave the working folder" };
    parts.push(part);
  }
  if (parts.length === 0) return { ok: false, reason: "path must name a file" };
  return { ok: true, path: parts.join("/") };
}
