# Admin UI direction — options to choose from

Context: Guild admin panel (settings: users, teams, models, integrations, SSO,
registry). Current stack: React 19 + Tailwind 4 + Vite, monorepo with
`packages/ui`. Current UI is functional but sparse: no data tables (just a
list of rows), detail pages float in whitespace, forms are bare, cards are
flat with no hierarchy.

All options below work on the existing stack. Pick a direction; the
components/layout get adapted, not installed wholesale.

---

## A. shadcn/ui + admin template skeleton (recommended default)

Copy shadcn/ui primitives into `packages/ui`, and base the admin shell on a
proven open-source template instead of designing from scratch.

- Template: **satnaing/shadcn-admin** — Vite + React + Tailwind, sidebar
  shell, settings pages, users list w/ data table, dark mode.
  https://github.com/satnaing/shadcn-admin (live demo linked in README)
- Full list of similar free templates:
  https://adminlte.io/blog/shadcn-admin-dashboard-templates/

Pros: free, MIT-style, copy-paste ownership of the code, matches current
stack exactly. Cons: still need to wire our data layer.

## B. shadcn/ui + component registries (build own shell, borrow pieces)

Same base as A, but instead of a template, pull high-quality building blocks:

- **Origin UI** — ~400 copy-paste form/input/settings-section components,
  follows shadcn conventions: https://originui.com/ (repo: shadcn/originui)
- **Kibo UI** — advanced composable components on top of shadcn: data
  tables with selection/pagination, command palettes:
  https://www.kibo-ui.com/
- **shadcn data table (TanStack Table v8)** — sortable/filterable/paginated
  tables: https://ui.shadcn.com/docs/components/radix/data-table

Pros: maximum control, best pieces available. Cons: assembly work on us.

## C. Tailwind Plus Application UI (official, paid)

The Tailwind team's own application-UI kit — settings screens, user
management pages, two-column sidebar layouts, tables. Reference-grade
patterns you copy into the project (one-time purchase license).

- Settings screens: https://tailwindcss.com/plus/ui-blocks/application-ui/page-examples/settings-screens
- Category overview: https://tailwindcss.com/plus

Pros: extremely polished, consistent. Cons: paid; markup-only (no React
logic), adapt to React ourselves.

## D. Refine (headless CRUD framework) + shadcn

Framework that handles the CRUD data layer (list/edit/create/delete,
routing, forms, optimistic updates) and lets shadcn/ui provide the look.

- Refine + shadcn docs: https://refine.dev/core/docs/ui-integrations/shadcn/introduction/
- Repo: https://github.com/refinedev/refine

Pros: least hand-written CRUD plumbing; scales to many resources. Cons:
one more framework in the stack; opinionated data-fetch model.

## E. Design references (pattern, not kit)

If the issue is more "look/feel" than tooling — steal the layout pattern
from products that manage users/teams/SSO for a living:

- **WorkOS dashboard** — users, teams, SSO connections, directory sync.
  Clean two-pane layout, dense tables, quiet dark theme.
  https://workos.com/docs/dashboard (SaaSFrame screenshots:
  https://www.saasframe.io/examples/workos-dashboard)
- **Clerk dashboard** — organization members, roles, invitations: closest
  domain match to Guild's Users/Teams pages. https://clerk.com
- **Stripe dashboard** — the reference for "settings with grouped vertical
  nav + detail panel + cards".
- **OpenAI Platform dashboard** — API keys/teams/usage in a dark, minimal
  shell.

---

## What to fix regardless of choice

- Lists become real data tables: search, filter, sort, pagination, row
  actions (edit/delete inline, not only on the detail page).
- Detail pages get structure: header with actions, cards/sections for
  fields, breadcrumbs — not fields floating in a column.
- Sidebar already has group labels (USER / ORGANIZATION) — keep, add
  collapse and icons consistent in weight.
- Destructive actions (Delete user/team) get a confirm dialog and
  semantic red styling.
- Empty states, loading skeletons, and toasts for save/delete outcomes.
