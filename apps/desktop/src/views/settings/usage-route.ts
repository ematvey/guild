// The usage section's URL state: period, group and metric ride in the query
// string, so deep links, reloads and back/forward restore the exact view.
// ChatRoute carries the parsed value; the section reads it as props.

export const USAGE_PERIODS = ["24h", "7d", "30d"] as const;
export type UsagePeriod = (typeof USAGE_PERIODS)[number];
export const USAGE_GROUPS = ["user", "team", "model"] as const;
export type UsageGroup = (typeof USAGE_GROUPS)[number];
export const USAGE_METRICS = ["cost", "tokens"] as const;
export type UsageMetric = (typeof USAGE_METRICS)[number];

export interface UsageQuery {
  period: UsagePeriod;
  group: UsageGroup;
  metric: UsageMetric;
}

export const DEFAULT_USAGE: UsageQuery = {
  period: "7d",
  group: "model",
  metric: "cost",
};

const oneOf = <T extends string>(
  values: readonly T[],
  value: string | null,
  fallback: T,
): T => (value !== null && (values as readonly string[]).includes(value) ? (value as T) : fallback);

/** Parses the usage query; an absent or unknown value takes its default. */
export function parseUsageQuery(search: string): UsageQuery {
  const q = new URLSearchParams(search);
  return {
    period: oneOf(USAGE_PERIODS, q.get("period"), DEFAULT_USAGE.period),
    group: oneOf(USAGE_GROUPS, q.get("group"), DEFAULT_USAGE.group),
    metric: oneOf(USAGE_METRICS, q.get("metric"), DEFAULT_USAGE.metric),
  };
}

/** The query string (with leading "?") for a usage view. */
export function usageQueryString(usage: UsageQuery): string {
  const q = new URLSearchParams();
  q.set("period", usage.period);
  q.set("group", usage.group);
  q.set("metric", usage.metric);
  return `?${q.toString()}`;
}
