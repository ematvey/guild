# Loading state audit, 2026-10-16

Pending data must not be rendered as absent, zero, default, or editable empty
content. Existing data remains visible during background refreshes.

| Surface | Correction |
| --- | --- |
| General | Logo and name placeholders until workspace loads; disable mutations; inline read failure |
| Approvals | No selected default or editable overrides until policy resolves; errors stay errors |
| Assistant | Text-shaped placeholders preserve field space; no premature default labels; failed reads cannot overwrite settings |
| About | Versions and latest release have separate pending and absent states |
| Account | Role and explanation wait for the account read |
| Observability | Totals wait for summary; call details wait for role; payload placeholders and errors |
| Usage | Small stat and chart placeholders; failures do not show zero spend or endless loading |
| Users, Teams | Form-shaped deep-link placeholders; missing records cannot become creation forms |
| Models | Compact form placeholders; absent routes/providers and read failures resolve explicitly |
| SSO, Machine, MCP, Integrations, Registry | Compact form/row placeholders in place of solid slabs; detail read failures surfaced |
| Settings module imports | Compact form placeholder while module loads |
| Chat history | One compact conversation-shaped placeholder instead of multiple fake tool blocks |
| Sidebar chats/projects, installer list | Text-sized row placeholders |
| Skills catalog, activity, detail, editor, local installs | Compact rows and text instead of large rectangles or centered spinners |
| Project picker and local/remote folder browser | Row placeholders while listings load |
| Desktop workspace switcher | Logo/name/list placeholders until sessions resolve |
| Shared tables | Row placeholders preserve table density |
| Shared skeleton | Subdued neutral fill; respects reduced-motion preference; visual pieces hidden from assistive technology, groups labeled |

Verification: desktop TypeScript/Vite build and Vitest suite, plus explicit
first-paint regression tests for General, Approvals, Assistant and About.
Live dev checks and release verification are recorded after deployment.
