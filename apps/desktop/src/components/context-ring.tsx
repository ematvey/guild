import { useEffect, useState } from "react";
import { fetchThreadContext, type ThreadContextUsage } from "../lib/thread-events";
import { DesktopTooltip } from "./desktop-tooltip";

const count = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

/** Only committed history revisions trigger a read; streaming text does not. */
export function ContextRing({ chatId, model, revision }: {
  chatId: string | null;
  model: string;
  revision: number | null;
}) {
  const key = `${chatId ?? ""}:${model}`;
  const [read, setRead] = useState<{ key: string; usage?: ThreadContextUsage; failed?: boolean }>();
  useEffect(() => {
    if (!chatId || !model) return;
    const controller = new AbortController();
    void fetchThreadContext(chatId, model, controller.signal).then(
      usage => { if (!controller.signal.aborted) setRead({ key, usage }); },
      () => { if (!controller.signal.aborted) setRead({ key, failed: true }); },
    );
    return () => controller.abort();
  }, [chatId, model, revision, key]);

  const usage = read?.key === key ? read.usage : undefined;
  const known = usage?.tokens != null && usage.max != null && usage.max > 0;
  const percent = known ? Math.round(usage.tokens! / usage.max! * 100) : null;
  const fill = percent === null ? 0 : Math.max(0, Math.min(100, percent));
  const label = known
    ? `Context: ~${count.format(usage.tokens!)} / ${count.format(usage.max!)} tokens (${percent}%). Last completed request, including its response${usage.usage_model !== model ? `; measured on ${usage.usage_model_alias ?? "a model the catalog no longer lists"}` : ""}.`
    : !chatId ? "Context usage available after the first response"
    : !model ? "Choose a model to see context usage"
    : read?.key !== key ? "Loading context usage"
    : read.failed ? "Context usage unavailable"
    : "Context usage available after the next response";
  const color = percent !== null && percent >= 95 ? "text-destructive"
    : percent !== null && percent >= 80 ? "text-amber-500" : "text-muted-foreground";

  return (
    <DesktopTooltip label={label} side="top">
      <span role="img" aria-label={label} tabIndex={0} data-context-ring
        className={`flex size-7 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring ${color}`}>
        <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <circle cx="10" cy="10" r="7.5" stroke="currentColor" strokeWidth="2" opacity="0.25" />
          {percent !== null && <circle cx="10" cy="10" r="7.5" stroke="currentColor" strokeWidth="2"
            pathLength="100" strokeDasharray={`${fill} 100`} strokeLinecap={fill > 0 ? "round" : "butt"}
            transform="rotate(-90 10 10)" />}
        </svg>
      </span>
    </DesktopTooltip>
  );
}
