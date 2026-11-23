// Shared markdown rendering for thread content and the skill editor's
// read-only preview: the body styling classes plus the link/image anchor
// components (links open externally; model-controlled images render as
// placeholders instead of loading) and the Generated UI blocks.

import type { Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { openExternal } from "../lib/open-external";
import { GenuiBlock, isGenuiLanguage } from "./genui/genui-block";
import { ContentImage } from "./genui/image";

interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: { className?: unknown };
  children?: HastNode[];
}

/** A fenced block's language class and text, read from the `pre` node. */
function fencedCode(node: HastNode | undefined): { className: string; text: string } | null {
  const code = node?.children?.find((c) => c.type === "element" && c.tagName === "code");
  if (!code) return null;
  const cls = code.properties?.className;
  const className = Array.isArray(cls) ? cls.join(" ") : typeof cls === "string" ? cls : "";
  const text = (code.children ?? []).map((c) => (c.type === "text" ? (c.value ?? "") : "")).join("");
  return { className, text };
}

/// Plugin set for chat text: GFM tables and task lists, plus a line break at
/// every newline the model wrote. CommonMark folds a single newline into a
/// space, which turns a list written with plain bullet characters into one
/// paragraph. A message is prose on a screen, not a document: its lines stay
/// lines.
export const CHAT_MD_PLUGINS = [remarkGfm, remarkBreaks];

/// Anchor for markdown content: every link routes through `openExternal`.
/// Images load by the org's remote-image policy.
export const mdComponents: Components = {
  // A fenced `openui` block is Generated UI: it renders as components.
  pre: ({ node, children, ...rest }) => {
    const code = fencedCode(node as HastNode | undefined);
    if (code !== null && isGenuiLanguage(code.className)) return <GenuiBlock source={code.text} />;
    return <pre {...rest}>{children}</pre>;
  },
  a: ({ node: _node, href, children, ...rest }) => (
    <a
      {...rest}
      href={href}
      onClick={(e) => {
        if (href) {
          e.preventDefault();
          openExternal(href);
        }
      }}
    >
      {children}
    </a>
  ),
  // Images follow the org's remote-image policy (see genui/image.tsx).
  img: ({ node: _node, src, alt }) => (
    <ContentImage
      src={typeof src === "string" ? src : undefined}
      alt={alt}
      className="my-2 max-h-[28rem] max-w-full rounded-lg border border-border object-contain"
    />
  ),
};

/// Markdown body class shared by text blocks, tool-card excerpts and the
/// skill editor's preview.
export const MD_CLASS =
  "[overflow-wrap:anywhere] " +
  "[&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-base [&_h1,&_h2,&_h3]:font-semibold [&_li]:ml-0 [&_ol]:list-decimal [&_ol]:pl-7 [&_ul]:pl-7 [&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-muted [&_pre]:p-3 [&_pre]:text-base [&_pre_[code]]:bg-transparent [&_pre_[code]]:p-0 [&_ul]:list-disc";
// Long unbreakable tokens (inline code, URLs) must wrap inside the message
// column, never widen it into a horizontal page scroll. overflow-wrap
// inherits, so the one declaration at the top of MD_CLASS covers every
// child; non-markdown blocks carry WRAP_ANYWHERE explicitly.
export const WRAP_ANYWHERE = "[overflow-wrap:anywhere]";

/// GFM tables: block-level so wide tables scroll horizontally inside the
/// chat column instead of squishing; cell padding keeps adjacent columns
/// visually separated.
/// MD_CLASS sets `overflow-wrap:anywhere`, which drops every cell's minimum
/// width to one character and lets the auto layout crush short columns into
/// vertical letters; tables take `break-word` instead, so a column never
/// gets narrower than its longest word.
export const MD_TABLE_CLASS =
  "[&_table]:my-2 [&_table]:block [&_table]:w-full [&_table]:max-w-full [&_table]:overflow-x-auto [&_table]:[overflow-wrap:break-word] [&_table]:text-base [&_th]:border-b-2 [&_th]:border-border [&_th]:px-3 [&_th]:py-1.5 [&_th]:text-left [&_th]:font-semibold [&_td]:border-t [&_td]:border-border [&_td]:px-3 [&_td]:py-1.5 [&_td]:align-top [&_tbody_tr:nth-child(even)]:bg-muted/40";
