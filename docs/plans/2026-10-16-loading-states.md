# Loading state audit, 2026-10-16

Status: **implemented** (2026-10-16); a record of the audit and its corrections. The shared skeleton is `packages/ui/src/components/skeleton.tsx`.

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
| Sidebar chats/projects, installer list | Text-sized row placeholders; expanded projects wait for the chat list before claiming no chats |
| Skills catalog, activity, detail, source manifest, editor, local installs | Compact rows and text instead of large rectangles or centered spinners |
| Project picker and local/remote folder browser | Row placeholders while listings load |
| Desktop workspace switcher | Logo/name/list placeholders until sessions resolve |
| Shared tables | Row placeholders preserve table density |
| Shared skeleton | Subdued neutral fill; respects reduced-motion preference; visual pieces hidden from assistive technology, groups labeled |

Verification completed against dev on 2026-10-16:

- TypeScript/Vite production build passes; 352 Vitest tests pass (27 files),
  including first-paint checks for General, Approvals, Assistant and About,
  and transport checks for failed reads versus successful absent overrides.
- Authenticated browser with real requests held open: General, Approvals,
  Assistant, About, Users, Observability, user/team details and skill source
  previews display placeholders without claiming absence or defaults.
  Releasing requests restores real content and removes placeholders.
- Simulated General/Approvals/Assistant read failures show errors, remove
  skeletons, and prevent edits to unread settings. A successful workspace
  response without a logo displays the actual empty state.
- User/team lookups show not-found only after completed lookups. Light and
  dark skeletons visually inspected; reduced-motion emulation confirms
  computed animation is `none`. General checked at a 390px viewport with
  no document overflow. Browser error collection was empty.
- Compose rebuild completed successfully. Both `localhost:18080` and
  `guild.example.com` serve `index-IkPXRbty.js`; health reports `0.5.68`.
- Desktop release `0.5.68` published to dev: six artifacts, all upload
  SHA-256 checks passed. `latest.json` contains signed entries for Windows,
  Linux, macOS arm64 and macOS x86_64. A real signed Windows installer
  download matches its registry checksum. Platform binaries were packaged,
  not launched during this UI task. Prod was untouched.
