# Admin UI rework — production-grade settings

Date: 2026-09-13. Branch: `admin-ui-rework`.
Decision doc: `docs/admin-ui-options.md` (chosen direction: keep shadcn/ui
base, add a proper data table + polish layer; Kibo-style tables).

## Problem

The settings/admin UI is PoC-grade: lists are hand-rolled stacked buttons
(no search/sort/pagination/row actions), detail pages float in whitespace,
forms are bare inputs with uppercase labels, destructive actions are
two-step inline buttons, no toasts, no real empty states, inconsistent
spacing across the 10 sections.

## Design

Keep: shadcn/ui base (`packages/ui`), the settings shell routing
(URL-driven sections + detail sub-pages), the stale-while-revalidate cache
(`use-cached-api.ts`), the theme tokens (light + dark).

Build once, use everywhere (new shared kit in `packages/ui` + a few
settings-local primitives in `apps/desktop/src/views/settings/components/`):

- **DataTable** (`packages/ui/src/components/data-table.tsx`): TanStack
  Table v8 — client-side search input, sortable columns, pagination,
  row click + optional per-row action menu, loading skeleton, empty state.
  Used by Users, Teams, Models, Integrations, Registry lists.
- **PageHeader** (`settings/components/page-header.tsx`): section title +
  description + right-aligned actions; detail pages use the same with a
  breadcrumb back link.
- **Field** (`settings/components/field.tsx`): label + control + hint with
  consistent spacing (replaces ad-hoc uppercase `<p>` labels).
- **ConfirmDialog** (`packages/ui` alert-dialog): real dialog for delete
  actions (replaces two-step inline buttons everywhere).
- **Toast** (sonner): success/error feedback for save/delete/add actions.
- **EmptyState** (`settings/components/empty-state.tsx`): icon + text +
  optional action, dashed card.
- Fact cards: detail pages show saved data as labelled cards in a
  consistent grid; edit stays an explicit mode (existing convention).

Shell: sidebar gets active-state indicator and tighter grouping; content
column widens to `max-w-4xl` (tables need it); section pages get a uniform
header rhythm. Account/Appearance/Machine/Approvals/Assistant get light
consistency polish, not redesigns.

## Section order (priority)

1. Users (table + detail), 2. Teams, 3. Models, 4. Integrations,
5. Registry, 6. SSO, 7. Usage (header/picker restyle), 8. user sections.

## Verification

- `tsc` + `vite build` clean for the desktop app.
- Deploy to the compose stack (:18080) and click through users/teams/
  integrations/models/registry in the browser (deep links, create, edit,
  delete, toasts).
- Cargo tests untouched (UI-only change) — suite stays green.
