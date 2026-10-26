// Collapsible bundle file tree shared by the skill detail page's Files
// section and the skill editor. Directories sort before files; a click on
// a directory folds it, a click on a file selects it.

import { useState } from "react";
import { ChevronDown, ChevronRight, File, Folder } from "lucide-react";
import type { FileTreeNode } from "./skill-files";

export interface FileTreeProps {
  nodes: FileTreeNode[];
  /** The selected file path (highlighted). */
  selected: string;
  onSelect: (path: string) => void;
}

export function FileTree({ nodes, selected, onSelect }: FileTreeProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const toggle = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const render = (list: FileTreeNode[], depth: number) =>
    list.map((node) =>
      node.kind === "dir" ? (
        <div key={`dir:${node.path}`}>
          <button
            type="button"
            aria-expanded={!collapsed.has(node.path)}
            onClick={() => toggle(node.path)}
            className="flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left text-sm text-muted-foreground outline-none hover:bg-accent"
            style={{ paddingLeft: `${8 + depth * 14}px` }}
          >
            {collapsed.has(node.path) ? (
              <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
            )}
            <Folder className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{node.name}/</span>
          </button>
          {collapsed.has(node.path) ? null : render(node.children, depth + 1)}
        </div>
      ) : (
        <button
          key={`file:${node.path}`}
          aria-current={selected === node.path ? "true" : undefined}
          onClick={() => onSelect(node.path)}
          style={{ paddingLeft: `${8 + depth * 14}px` }}
          className={`flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left text-sm outline-none hover:bg-accent ${
            selected === node.path ? "bg-secondary" : ""
          }`}
        >
          <File className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{node.name}</span>
        </button>
      ),
    );

  return <>{render(nodes, 0)}</>;
}
