// An integration's brand mark and the labels its metadata shows under.

import { useEffect, useRef, useState } from "react";
import { Plug } from "lucide-react";
import { useTheme } from "../../theme";
import { openExternal } from "../../lib/open-external";

const CATEGORY_LABELS: Record<string, string> = {
  search: "Search",
  fetch: "Fetch",
  observability: "Observability",
  crm: "CRM",
  messaging: "Messaging",
  docs: "Docs",
  code: "Code",
  other: "Other",
  mcp: "MCP server",
};

export const categoryLabel = (c?: string) => CATEGORY_LABELS[c ?? "other"] ?? c ?? "Other";

export const TRAIT_LABELS: Record<string, string> = {
  web_search: "Web search",
  web_fetch: "Web fetch",
};

export const traitLabel = (t: string) => TRAIT_LABELS[t] ?? t.replace(/_/g, " ");

export const SOURCE_LABELS = {
  builtin: "Included with Guild",
  registry: "Plugin",
  mcp: "MCP server",
} as const;

/** A data URL for an SVG document. `currentColor` is replaced by `color`
 *  first: an <img> does not inherit the page's text color. */
export function svgDataUrl(svg: string, color: string): string {
  const bytes = new TextEncoder().encode(svg.replaceAll("currentColor", color));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return `data:image/svg+xml;base64,${btoa(binary)}`;
}

/** The brand mark, drawn as an image so manifest markup never enters the
 *  DOM (no script, no handlers). A mark drawn in currentColor takes the
 *  surrounding foreground color, re-read on theme change. A plugin without
 *  a logo gets its title's initial on a tile. */
export function Logo({ svg, title = "", size = "size-10" }: { svg: string; title?: string; size?: string }) {
  const { theme } = useTheme();
  const ref = useRef<HTMLDivElement>(null);
  const [color, setColor] = useState<string | null>(null);
  useEffect(() => {
    // Next frame: the provider applies the theme class after this effect.
    const frame = requestAnimationFrame(() => {
      if (ref.current) setColor(getComputedStyle(ref.current).color);
    });
    return () => cancelAnimationFrame(frame);
  }, [theme, svg]);
  if (svg === "") {
    const initial = title.trim().charAt(0).toUpperCase();
    return (
      <div
        aria-hidden
        className={`${size} flex shrink-0 items-center justify-center rounded-md bg-muted font-medium text-muted-foreground`}
      >
        {initial !== "" ? initial : <Plug className="size-4" />}
      </div>
    );
  }
  return (
    <div ref={ref} aria-hidden className={`${size} flex shrink-0 items-center justify-center text-foreground`}>
      {color !== null && <img alt="" src={svgDataUrl(svg, color)} className="h-full w-full object-contain" />}
    </div>
  );
}

/** A link out of the app: the desktop shell opens it in the browser. */
export function ExternalLinkText({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => {
        e.preventDefault();
        openExternal(href);
      }}
      className="inline-flex items-center gap-1 underline-offset-2 hover:underline"
    >
      {children}
    </a>
  );
}

/** The host a docs link points at, for its label. */
export function linkHost(href: string): string {
  try {
    return new URL(href).host;
  } catch {
    return href;
  }
}
