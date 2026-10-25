lane:       ui-thread
read:       40 files, all read in full
model:      5 concepts added, 42 attaches, 8 no_concept, 0 types_no_concept
gaps:       none added
findings:   4 mechanical, 12 design
note:       check.py does not flag one concept id defined in several fragments. Eight ids repeat across fragments: machine, approval, skill, agent, project, session, chat, thread-event.

FINDING:  Approval mode has two vocabularies and one hand-written mapping.
PATTERN:  alias-collision
WHERE:    apps/desktop/src/views/settings/sections/ApprovalsSection.tsx:16 and apps/desktop/src/views/thread/approval.ts:38
COST:     A reader must learn policy values server/ask/allow/never, chat values ask/approve_for_me/full_access, and the mapping. "server" and "default" both mean unset.
OPTION A: keep the policy enum - rename the chat "default" to "server", add a real mapping function, and decide whether "never" has a chat mode. Breaks the current "Deny all" label. Small effort.
OPTION B: keep the chat enum - store the three chat modes in settings and drop "server"/"never". Breaks deny-all policy and the server default. Medium effort.
ASK:      Is "Deny all" a chat mode, or only an account policy with no chat equivalent?

FINDING:  SidebarTab and ChatRoute.tab are two "tab" types with different value sets.
PATTERN:  alias-collision
WHERE:    apps/desktop/src/views/sidebar-rail.tsx:23 and apps/desktop/src/views/thread/route.ts:53
COST:     One word names a panel tab (three route values) and a rail entry (six values, including page routes). The projection is written by hand in Thread.tsx:931-940.
OPTION A: keep ChatRoute.tab - derive the rail entry from the route and remove SidebarTab. Breaks rail code that names "agents", "activity" and "skills" directly. Medium effort.
OPTION B: keep SidebarTab - add the page tabs to ChatRoute.tab so both types hold the same values. Breaks the route parser and every exhaustive switch. Medium effort.
ASK:      Is a rail entry a route, or a panel state?

FINDING:  A project-bound chat changes the visible tab without a URL change.
PATTERN:  boundary
WHERE:    apps/desktop/src/views/thread/Thread.tsx:1079 and apps/desktop/src/views/thread/Thread.tsx:931
COST:     /thread/<id> for a project chat shows the Work tab, but the URL still says Chats. Reload and back/forward do not restore the tab. sidebarTab also duplicates route.tab.
OPTION A: keep the URL as truth - open project chats on /project/<id>/thread/<cid> and delete the local tab decision. Breaks old /thread/<id> links for project chats. Medium effort.
OPTION B: keep the local decision - accept a state-only tab and document the exception. Breaks the AGENTS.md rule that all navigation state is URL state. Small effort.
ASK:      Must a project chat's URL name the Work tab?

FINDING:  Two folder browsers implement the same project folder pick.
PATTERN:  duplicate
WHERE:    apps/desktop/src/views/projects/PathSpecifier.tsx:36 and apps/desktop/src/views/projects/RemotePathSpecifier.tsx:32
COST:     Two components repeat the reducer wiring, listing effects, key handling and confirm button. A fix must land in both. The remote file says it has the same UX as the WSL file.
OPTION A: keep one specifier - pass a listing transport and a path style into one component. Breaks the WSL UNC edge conversion that lives only in PathSpecifier. Medium effort.
OPTION B: keep two specifiers - extract the shared body and leave only the transport and path adapter in each. Breaks nothing. Small effort.
ASK:      Do WSL UNC paths and remote Linux paths share one picker, or is UNC a permanent special case?

FINDING:  Two folder equality rules sit in one dialog.
PATTERN:  duplicate
WHERE:    apps/desktop/src/views/projects/CreateProjectDialog.tsx:92 and apps/desktop/src/views/projects/CreateProjectDialog.tsx:101
COST:     The local rule lowercases and strips trailing backslashes. The remote rule is exact. A reader must know which machine type uses which rule, and why.
OPTION A: keep one lookup - give it a path-key function and name the two rules explicitly. Breaks nothing. Small effort.
OPTION B: keep two lookups - move existing-project resolution to the server, where folder identity already lives. Breaks the instant open path. Medium effort.
ASK:      Is folder identity case-insensitive only for Windows/WSL, and who owns that rule?

FINDING:  Settings views bypass the typed API modules and call endpoint paths directly.
PATTERN:  boundary
WHERE:    apps/desktop/src/views/settings/sections/ModelsSection.tsx:105 and apps/desktop/src/views/settings/sections/McpSection.tsx:142
COST:     Gateway routes, MCP servers, teams, registry items and releases are read and written by literal URL strings in views. Approvals, machines and API keys use typed modules. The model's wire-to-ui path is not the path these views use.
OPTION A: keep typed modules - move every settings call behind a lib/api module. Breaks the direct cache paths. Medium effort.
OPTION B: keep direct calls - declare these views as wire consumers in the model. Breaks the current ui-only role. Small effort.
ASK:      May a settings view know endpoint paths?

FINDING:  The default assistant prompt exists in two copies.
PATTERN:  duplicate
WHERE:    apps/desktop/src/views/settings/sections/AssistantSection.tsx:22 and apps/server/src/harness/extension.ts:19
COST:     The two strings are equal today. If the server default changes, the settings box still shows the old text as the effective fallback.
OPTION A: keep one copy - the read response carries the effective default, and the client stops hardcoding it. Breaks the current null-means-default contract. Medium effort.
OPTION B: keep two copies - add a test that pins both strings and fails on drift. Breaks nothing. Small effort.
ASK:      Which copy is the default when they differ?

FINDING:  Machine presence has two client names and two sources.
PATTERN:  alias-collision
WHERE:    apps/desktop/src/views/settings/sections/MachineSection.tsx:52 and apps/desktop/src/views/thread/Thread.tsx:1885
COST:     The settings list reads m.connected from the machines store. The composer reads row.machine_online from the chat list, then falls back to machines.connected. The two dots can disagree.
OPTION A: keep the machines store - make it the only presence source and drop machine_online from the chat row path. Breaks the chat-list first-paint fallback. Medium effort.
OPTION B: keep the chat row - treat presence as a chat-list fact and stop reading connected in the composer. Breaks live presence for a new chat with no row. Medium effort.
ASK:      Is presence a machine fact or a chat-list fact?

FINDING:  Three module-level settings caches have three invalidation paths.
PATTERN:  duplicate
WHERE:    apps/desktop/src/views/settings/use-cached-api.ts:32 and apps/desktop/src/views/settings/sections/GatewaySection.tsx:45 and apps/desktop/src/views/settings/sections/McpSection.tsx:62
COST:     Sign-out must call clearApiCache and clearGatewayCache. toolCounts has no clear call. A new settings cache can leak one user's data into the next session.
OPTION A: keep one cache - route all settings data through the epoch-guarded store. Breaks the per-section cache shapes. Medium effort.
OPTION B: keep per-section caches - add one clear function that every cache registers with. Breaks nothing. Small effort.
ASK:      Must every settings cache clear on sign-out through one call?

FINDING:  Each settings section parses the same detail string with its own grammar.
PATTERN:  boundary
WHERE:    apps/desktop/src/views/settings/section-nav.ts:4 and apps/desktop/src/views/settings/sections/ModelsSection.tsx:71
COST:     The detail string means "add", "provider/new", "provider/<slug>", a model id, "<kind>/<slug>", "new" or an id, depending on the section. No central parser or validation exists.
OPTION A: keep the string - give each section a small codec behind one interface. Breaks nothing. Medium effort.
OPTION B: keep ad hoc parsing - document each section's grammar next to section-nav.ts. Breaks nothing. Small effort.
ASK:      Should settingsDetail be a typed sub-route rather than an opaque string?

FINDING:  Usage filters are URL state outside the route model.
PATTERN:  boundary
WHERE:    apps/desktop/src/views/settings/sections/UsageSection.tsx:54 and apps/desktop/src/views/thread/route.ts:53
COST:     period, group and metric live in the query string with their own popstate listener and pushState. The route parser ignores them, so deep links work only because the section reads window directly.
OPTION A: keep one route model - extend ChatRoute with the usage query state. Breaks the route parser and its tests. Medium effort.
OPTION B: keep section-local state - declare a second URL contract for section query state. Breaks the single-route rule. Small effort.
ASK:      Do usage filters belong in the app route model?

FINDING:  The full-page tab layout rule is split across two modules.
PATTERN:  boundary
WHERE:    apps/desktop/src/views/thread/status.ts:175 and apps/desktop/src/views/thread/Thread.tsx:1287
COST:     tabPaneLayout says only "skills" has no aside. Thread hardcodes skills OR agents. A new full-page tab needs edits in both places.
OPTION A: keep one rule - tabPaneLayout returns the page kind from the route for every full-page tab. Breaks its current signature. Small effort.
OPTION B: keep the check in Thread - delete tabPaneLayout and its test. Breaks nothing. Small effort.
ASK:      Which module owns "does this tab replace the sidebar?"

FINDING:  chrome.tsx holds two dangling comment fragments.
PATTERN:  dead-code
WHERE:    apps/desktop/src/views/sidebar/chrome.tsx:36 and apps/desktop/src/views/sidebar/chrome.tsx:57
COST:     A reader sees an "Inline rename field" comment with no component, and a duplicated "Drawer close" comment. The file looks truncated.
OPTION A: delete the orphan fragments - no code refers to them. Breaks nothing. Small effort.
OPTION B: restore the missing rename component - only if a caller still needs it. Breaks nothing. Medium effort.
ASK:      None.

FINDING:  APPROVAL_MODE_LABELS repeats the labels in APPROVAL_MODES.
PATTERN:  duplicate
WHERE:    apps/desktop/src/views/thread/approval.ts:7 and apps/desktop/src/views/thread/approval.ts:29
COST:     A label change must be made twice. A third label, "Deny all", exists only in accountDefaultLabel.
OPTION A: derive the label map from APPROVAL_MODES and delete the second constant. Breaks nothing. Small effort.
OPTION B: keep the map and remove the label field from APPROVAL_MODES. Breaks the picker that reads entry.label. Small effort.
ASK:      None.

FINDING:  The Tauri runtime check exists in three copies.
PATTERN:  duplicate
WHERE:    apps/desktop/src/views/thread/Thread.tsx:114 and apps/desktop/src/views/thread/ThreadOverlays.tsx:12
COST:     IS_TAURI already lives in lib/session.ts. A change to desktop detection can miss a local copy.
OPTION A: import IS_TAURI in both files and delete the local constants. Breaks nothing. Small effort.
OPTION B: keep local constants and remove IS_TAURI from the imports. Breaks every other caller. Large effort.
ASK:      None.

FINDING:  resolve-project-dir claims "most recent chat" but trusts list order.
PATTERN:  duplicate
WHERE:    apps/desktop/src/views/settings/resolve-project-dir.ts:13 and apps/desktop/src/views/projects/projects.ts:35
COST:     The recency rule already exists as byRecentActivity. This function uses the first project-bound row in server order, so the comment can be false.
OPTION A: sort the chats with byRecentActivity before the find. Breaks nothing. Small effort.
OPTION B: keep server order and change the comment to name that contract. Breaks nothing. Small effort.
ASK:      None.
