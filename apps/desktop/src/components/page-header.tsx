// The one page header: a page's title (the section-title role, `text-lg`),
// an optional description, right-aligned actions, a back link for detail
// pages and a tab row. `bar` spans the column over a bottom border (the
// agents and skills pages); `section` sits at the top of a scrolling
// section (settings).
//
// The title keeps room for itself: when the actions do not fit beside it,
// they drop to their own line at the right end instead of squeezing the
// title into a column too narrow to read.

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
          : `sticky top-0 z-10 mb-6 flex min-h-11 flex-col justify-center border-b border-border bg-background py-1.5 ${CAPTION_BUTTONS_INSET}`
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
      {bar ? (
        <div className="flex flex-wrap items-center gap-3 pb-3">
          <div className="min-w-0 w-full sm:w-auto sm:flex-1">
            <h1 className="truncate text-lg font-semibold tracking-tight">{title}</h1>
            {description !== undefined && description !== "" && (
              <p className="mt-0.5 truncate text-sm text-muted-foreground">{description}</p>
            )}
          </div>
          {actions !== undefined && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <h1 className="min-w-0 grow basis-32 truncate text-lg font-semibold tracking-tight">{title}</h1>
            {actions !== undefined && (
              <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div>
            )}
          </div>
          {description !== undefined && description !== "" && (
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{description}</p>
          )}
        </>
      )}
      {tabs !== undefined && <div className="flex flex-wrap items-center gap-3">{tabs}</div>}
    </header>
  );
}
