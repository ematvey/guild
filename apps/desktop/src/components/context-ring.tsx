import { useSyncExternalStore } from "react";
import { useContextUsage } from "../lib/context-usage-store";
import { modelsSnapshot, subscribeModels } from "../lib/models-store";
import { DesktopTooltip } from "./desktop-tooltip";

const count = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

/** The composer's context meter. The chat's usage arrives over the member
 *  socket (its sync bracket, then every turn end and compaction); the
 *  denominator is the selected model's context window from the pushed
 *  model list. */
export function ContextRing({ chatId, model }: {
  chatId: string | null;
  model: string;
}) {
  const pushed = useContextUsage(chatId);
  const models = useSyncExternalStore(subscribeModels, modelsSnapshot, modelsSnapshot);
  const max = models?.find((m) => m.id === model)?.context_window ?? null;
  const usage = pushed === undefined ? undefined : { ...pushed, max };
  const known = usage?.tokens != null && usage.max != null && usage.max > 0;
  const percent = known ? Math.round(usage.tokens! / usage.max! * 100) : null;
  const fill = percent === null ? 0 : Math.max(0, Math.min(100, percent));
  const label = known
    ? `Context: ~${count.format(usage.tokens!)} / ${count.format(usage.max!)} tokens (${percent}%). Last completed request, including its response${usage.usage_model !== model ? `; measured on ${usage.usage_model_alias ?? "a model the catalog no longer lists"}` : ""}.`
    : !chatId ? "Context usage available after the first response"
    : !model ? "Choose a model to see context usage"
    : usage === undefined ? "Loading context usage"
    : usage.tokens != null && max === null ? "Context usage unavailable"
    : "Context usage available after the next response";
  const color = percent !== null && percent >= 95 ? "text-destructive"
    : percent !== null && percent >= 80 ? "text-amber-500" : "text-muted-foreground";

  return (
    <DesktopTooltip label={label} side="top">
      <span role="img" aria-label={label} tabIndex={0} data-context-ring
        className={`flex size-8 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:size-10 ${color}`}>
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <circle cx="10" cy="10" r="7.5" stroke="currentColor" strokeWidth="2" opacity="0.25" />
          {percent !== null && <circle cx="10" cy="10" r="7.5" stroke="currentColor" strokeWidth="2"
            pathLength="100" strokeDasharray={`${fill} 100`} strokeLinecap={fill > 0 ? "round" : "butt"}
            transform="rotate(-90 10 10)" />}
        </svg>
      </span>
    </DesktopTooltip>
  );
}
