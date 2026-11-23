# Type and icon scale

One scale, six roles. Every element that shows text or an icon belongs to
one of them. A view names a step; it never sets a size of its own.

The steps live in `packages/ui/src/theme.css` (`--text-3xs` … `--text-2xl`).
A narrow screen shifts every step up by two pixels; nothing else changes.
`body` carries `text-sm`, so an element that names no step still lands on
the scale.

| Role | Step | Icons | What belongs here |
|---|---|---|---|
| Reading | `text-base` | `size-4` | Chat messages, composer input and Agent badge, message timestamps, thread title, Chats sidebar rows and rename fields, Markdown tables and code, generated UI text |
| Chrome | `text-sm` | `size-4` control, `size-3.5` inline | Buttons, inputs, selects, menus, dialogs' body, list rows, tool cards, settings labels, toasts |
| Section title | `text-lg` | `size-5` | Dialog title, settings section heading, empty-state heading |
| Metadata | `text-xs` | `size-3.5` | Run timestamps, run status, origin links, hints under a label, badges, chart labels |
| Dense data | `text-2xs` | `size-3` | Trace and log tables, token and cost figures, rail captions, attachment chips |
| Micro | `text-3xs` | `size-2.5` | Keyboard hints, counters, the sidebar rail |

### Icon buttons

| Role | Box | Glyph | Where |
|---|---|---|---|
| Toolbar | `size-9` (36) | `size-4` | Header, sidebar chrome, dialog rows, list row actions |
| Composer | `size-8` (32) | `size-4` | Attach, send, approval mode, project chip, agent chip, context ring — one height for the whole row |
| Touch | `pointer-coarse:size-10` (40) | `size-4` | Added to both of the above |

Apple's minimum touch target is 44. The touch step closes most of that gap
without changing desktop density; the composer stays compact on a mouse.

## Rules

- **Prose is reading, chrome is chrome.** A paragraph the user reads for
  meaning takes `text-base`. A label, a control or a list row takes
  `text-sm`. This is the only distinction that matters at a glance.
- **Nothing sets a raw size.** No `text-[13px]`, no `font-size` in CSS, no
  `fontSize` prop. Relative sizes (`em`) are allowed only inside rendered
  markdown, where they follow the surrounding prose.
- **Icons follow their row.** An icon inside `text-sm` is `size-4` when it
  is a control and `size-3.5` when it sits in a line of text. An icon next
  to `text-base` prose is `size-4`.
- **Line height comes from the step** (`--text-*--line-height`). The one
  deliberate exception is the reading surface, which sets `leading-[1.75]`:
  a paragraph needs a looser line than a label does.
- **The phone differs by a shift, not a multiplier.** A multiplier widens
  every gap and the band stops reading as one system.

## Adding an element

Pick the role, take the step and the icon size. If no role fits, the
element is probably doing two jobs — split it before adding a step.
