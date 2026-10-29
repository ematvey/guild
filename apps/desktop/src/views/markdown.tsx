// Shared markdown rendering for thread content and the skill editor's
// read-only preview: the body styling classes plus the link/image anchor
// components (links open externally; model-controlled images render as
// placeholders instead of loading).

import type { Components } from "react-markdown";
import { openExternal } from "../lib/open-external";

/// Anchor for markdown content: every link routes through `openExternal`.
/// Images never load from model/tool-controlled URLs: injected markdown
/// could otherwise exfiltrate via the image request; a rendered placeholder
/// links out instead.
export const mdComponents: Components = {
  a: ({ node: _node, href, children, ...rest }) => (
    <a
      {...rest}
      href={href}
      onClick={e => {
        if (href) {
          e.preventDefault();
          openExternal(href);
        }
      }}
    >
      {children}
    </a>
  ),
  img: ({ node: _node, src, alt }) => {
    const url = typeof src === "string" ? src : undefined;
    const label = alt || url || "image";
    return (
      <button
        type="button"
        className="inline-flex max-w-full items-center gap-1 rounded border border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted"
        onClick={() => url && openExternal(url)}
      >
        🖼 {label}
      </button>
    );
  },
};

/// Markdown body class shared by text blocks, tool-card excerpts and the
/// skill editor's preview.
export const MD_CLASS =
  "[overflow-wrap:anywhere] " +
  "[&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-xs [&_h1,\&_h2,\&_h3]:font-semibold [&_li]:ml-0 [&_ol]:list-decimal [&_ol]:pl-7 [&_ul]:pl-7 [&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-muted [&_pre]:p-3 [&_pre]:text-xs [&_pre_[code]]:bg-transparent [&_pre_[code]]:p-0 [&_ul]:list-disc";
// Long unbreakable tokens (inline code, URLs) must wrap inside the message
// column, never widen it into a horizontal page scroll. overflow-wrap
// inherits, so the one declaration at the top of MD_CLASS covers every
// child; non-markdown blocks carry WRAP_ANYWHERE explicitly.
export const WRAP_ANYWHERE = "[overflow-wrap:anywhere]";

/// GFM tables: block-level so wide tables scroll horizontally inside the
/// chat column instead of squishing; cell padding keeps adjacent columns
/// visually separated (the old rendering had none, so columns merged).
/// MD_CLASS sets `overflow-wrap:anywhere`, which drops every cell's minimum
/// width to one character and lets the auto layout crush short columns into
/// vertical letters; tables take `break-word` instead, so a column never
/// gets narrower than its longest word.
export const MD_TABLE_CLASS =
  "[&_table]:my-2 [&_table]:block [&_table]:w-full [&_table]:max-w-full [&_table]:overflow-x-auto [&_table]:[overflow-wrap:break-word] [&_table]:text-xs [&_th]:border-b-2 [&_th]:border-border [&_th]:px-3 [&_th]:py-1.5 [&_th]:text-left [&_th]:font-semibold [&_td]:border-t [&_td]:border-border [&_td]:px-3 [&_td]:py-1.5 [&_td]:align-top [&_tbody_tr:nth-child(even)]:bg-muted/40";
