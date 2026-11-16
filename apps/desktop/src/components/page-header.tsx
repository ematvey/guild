// The one page header: a page's title (the section-title role, `text-lg`),
// an optional description, right-aligned actions, a back link for detail
// pages and a tab row. `bar` spans the column over a bottom border (the
// agents and skills pages); `section` sits at the top of a scrolling
// section (settings).

import type { ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { CAPTION_BUTTONS_INSET, titleBarDragDeep } from "../lib/titlebar";

export function PageHeader({
  title,
  description,
  actions,
  back,
  tabs,
  variant = "section",
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /** Renders a back link labelled `back` above the title (detail pages). */
  back?: { label: string; onClick: () => void };
  /** A row under the title: tabs, filters. */
  tabs?: ReactNode;
  variant?: "section" | "bar";
}) {
  const bar = variant === "bar";
  return (
    <header
      {...titleBarDragDeep}
      className={
        bar
          ? `shrink-0 border-b border-border bg-background px-4 pt-3 sm:px-6 ${CAPTION_BUTTONS_INSET}`
          : `sticky top-0 z-10 mb-6 border-b border-border bg-background ${CAPTION_BUTTONS_INSET}`
      }
    >
      {back && (
        <button
          onClick={back.onClick}
          className="mb-3 flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-4" /> {back.label}
        </button>
      )}
      <div className={bar ? "flex flex-wrap items-center gap-3 pb-3" : "flex items-start justify-between gap-4"}>
        <div className={bar ? "min-w-0 w-full sm:w-auto sm:flex-1" : "min-w-0"}>
          <h1 className="truncate text-lg font-semibold tracking-tight">{title}</h1>
          {description !== undefined && description !== "" && (
            <p
              className={
                bar ? "mt-0.5 truncate text-sm text-muted-foreground" : "mt-1 max-w-2xl text-sm text-muted-foreground"
              }
            >
              {description}
            </p>
          )}
        </div>
        {actions !== undefined && (
          <div className={bar ? "flex flex-wrap items-center gap-2" : "flex shrink-0 items-center gap-2"}>
            {actions}
          </div>
        )}
      </div>
      {tabs !== undefined && <div className="flex flex-wrap items-center gap-3">{tabs}</div>}
    </header>
  );
}
