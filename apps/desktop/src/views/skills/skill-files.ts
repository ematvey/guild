// Bundle file paths and their nested tree: the detail page's Files viewer
// and the editor's file tree both read a skill's flat bundle paths through
// these helpers, so one path model serves both.

/** True when a bundle file renders as markdown rather than raw text. */
export function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown)$/i.test(path);
}

/** The file list for a published skill: SKILL.md first (its body ships
 *  inline), then the bundle's extra files in path order. manifest.json is
 *  bundle metadata — never listed. */
export function bundleFilePaths(source: {
  skill_md: string;
  files: Array<{ path: string; size?: number; sha256?: string }>;
}): string[] {
  return [
    "SKILL.md",
    ...source.files
      .map((f) => f.path)
      .filter((p) => p !== "SKILL.md" && p !== "manifest.json")
      .sort(),
  ];
}

/** One node of the file tree. */
export interface FileTreeNode {
  name: string;
  /** File path, or the directory's path prefix (files under it). */
  path: string;
  kind: "dir" | "file";
  children: FileTreeNode[];
}

/** Nested file tree from flat bundle paths: directories before files,
 *  alphabetical within each group. */
export function buildFileTree(paths: string[]): FileTreeNode[] {
  const root: FileTreeNode = { name: "", path: "", kind: "dir", children: [] };
  for (const path of [...paths].sort()) {
    const parts = path.split("/");
    let node = root;
    parts.forEach((part, i) => {
      const kind = i === parts.length - 1 ? "file" : "dir";
      const nodePath = parts.slice(0, i + 1).join("/");
      let child = node.children.find((c) => c.name === part && c.kind === kind);
      if (child === undefined) {
        child = { name: part, path: nodePath, kind, children: [] };
        node.children.push(child);
      }
      node = child;
    });
  }
  const sortNode = (n: FileTreeNode): void => {
    n.children.sort((a, b) =>
      a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1,
    );
    n.children.forEach(sortNode);
  };
  sortNode(root);
  return root.children;
}

/** Why an extra bundle file path is not publishable, or null when it is.
 *  Mirrors the server's rule: relative, slash separated, no `.`/`..`
 *  segment, and never the two server-written files. */
export function filePathError(path: string): string | null {
  if (path === "") return "File path is required.";
  if (path === "SKILL.md" || path === "manifest.json") {
    return `${path} is written by the server.`;
  }
  if (path.startsWith("/")) return "File path must be relative.";
  if (path.includes("\\")) return "File path must use forward slashes.";
  if (path.split("/").some((seg) => seg === "" || seg === "." || seg === "..")) {
    return "File path has an empty or relative segment.";
  }
  if (path.length > 200) return "File path is too long.";
  return null;
}
