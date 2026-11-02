// MIME knowledge for attachments and tool artifacts: extension to content
// type, content type to modality, and content type to textual. One list per
// question, so inlining and spilling agree.

const CONTENT_TYPES: Record<string, string> = {
  csv: "text/csv",
  gif: "image/gif",
  htm: "text/html",
  html: "text/html",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  json: "application/json",
  md: "text/markdown",
  pdf: "application/pdf",
  png: "image/png",
  svg: "image/svg+xml",
  txt: "text/plain",
  webp: "image/webp",
  xml: "application/xml",
  zip: "application/zip",
};

/** Content type for a filename extension; unknown extensions are binary. */
export function contentTypeOf(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

/** The model-facing modality of a content type. */
export function modalityOf(contentType: string): string {
  const ct = contentType.toLowerCase();
  if (ct.startsWith("image/")) return "image";
  if (ct.startsWith("audio/")) return "audio";
  if (ct.startsWith("video/")) return "video";
  return "document";
}

/** Textual content types, without parameters. */
const TEXTUAL_TYPES = new Set([
  "application/json",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
  "application/javascript",
  "application/toml",
  "application/sql",
  "application/x-sh",
  "application/x-ndjson",
  "application/xhtml+xml",
  "application/rss+xml",
  "application/atom+xml",
  "application/csv",
  "application/x-www-form-urlencoded",
]);

/** Extensions that name text when the content type is generic. */
const TEXTUAL_EXTENSIONS = new Set([
  "md",
  "txt",
  "json",
  "rs",
  "py",
  "js",
  "ts",
  "tsx",
  "jsx",
  "toml",
  "yaml",
  "yml",
  "csv",
  "tsv",
  "log",
  "sh",
  "bash",
  "sql",
  "html",
  "htm",
  "css",
  "xml",
  "ini",
  "conf",
  "env",
  "c",
  "h",
  "cpp",
  "hpp",
  "go",
  "java",
  "rb",
  "php",
  "swift",
  "kt",
  "proto",
  "gradle",
  "lock",
  "gitignore",
  "dockerfile",
  "makefile",
  "patch",
  "diff",
]);

/** Whether a content type (and optionally a filename) is text. One answer for
 *  both inlining an attachment and spilling a tool result. */
export function isTextual(contentType: string, filename?: string): boolean {
  const ct = (contentType.split(";")[0] ?? "").trim().toLowerCase();
  if (ct.startsWith("text/") || TEXTUAL_TYPES.has(ct) || ct.endsWith("+json") || ct.endsWith("+xml")) {
    return true;
  }
  if (filename === undefined) return false;
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return TEXTUAL_EXTENSIONS.has(ext);
}
