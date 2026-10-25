/// Props sections accept when their sub-pages are URL-addressed
/// (/settings/<section>/<detail>): the open sub-page id (null = list page)
/// and the navigation callback that pushes the new URL. The usage section
/// also reads and writes its query state through the route.
import type { UsageQuery } from "./usage-route";

export interface SectionDetailProps {
  detail?: string | null;
  onDetailChange: (detail: string | null) => void;
  usage?: UsageQuery;
  onUsageChange?: (usage: UsageQuery) => void;
}

/** One section's sub-page grammar: the wire stays an opaque string, and the
 *  codec is the only place that reads or writes it. */
export interface DetailCodec<View> {
  parse(detail: string | null): View;
  format(view: View): string | null;
}

/** A section whose sub-pages are a create form ("new") or one row id. */
export type EntityDetail =
  | { kind: "list" }
  | { kind: "new" }
  | { kind: "row"; id: string };

export const entityDetailCodec: DetailCodec<EntityDetail> = {
  parse: (detail) =>
    detail === null
      ? { kind: "list" }
      : detail === "new"
        ? { kind: "new" }
        : { kind: "row", id: detail },
  format: (view) =>
    view.kind === "list" ? null : view.kind === "new" ? "new" : view.id,
};

/** A section whose sub-pages are one row id (no create form). */
export const rowDetailCodec: DetailCodec<string | null> = {
  parse: (detail) => detail,
  format: (view) => view,
};
