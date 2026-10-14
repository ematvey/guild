// The Observability section's URL contract: the section lives at
// /settings/observability, an open call row at /settings/observability/<id>
// (the section's <detail> segment — parseChatRoute handles both), and the
// dashboard's period + filters ride the URL query — so deep links, reloads
// and back/forward restore the exact view.

export interface ObservabilityFilters {
  period: "24h" | "7d" | "30d";
  caller: "all" | "model" | "judge";
  model: string;
  chat: string;
}

export const OBSERVABILITY_DEFAULTS: ObservabilityFilters = {
  period: "7d",
  caller: "all",
  model: "",
  chat: "",
};

/** Reads the dashboard filters off a URL; unknown values fall back to the
 *  defaults. */
export function readFiltersOf(url: URL): ObservabilityFilters {
  const q = url.searchParams;
  const period = q.get("period") as ObservabilityFilters["period"] | null;
  const caller = q.get("caller") as ObservabilityFilters["caller"] | null;
  return {
    period: period === "24h" || period === "7d" || period === "30d" ? period : OBSERVABILITY_DEFAULTS.period,
    caller: caller === "all" || caller === "model" || caller === "judge" ? caller : OBSERVABILITY_DEFAULTS.caller,
    model: q.get("model") ?? "",
    chat: q.get("chat") ?? "",
  };
}

/** Writes the filters back as query params (empty strings drop). */
export function filtersToQuery(filters: ObservabilityFilters, url: URL): void {
  for (const [key, value] of Object.entries(filters)) {
    if (value === "" || value === undefined) url.searchParams.delete(key);
    else url.searchParams.set(key, String(value));
  }
}
