# Guild UI principles

## Guild and Guild Control Center

- Guild is the daily-use app for chats, projects, apps, scheduled tasks, skills, personal settings, and device setup. Chat actions and conversations stay available in Work.
- Guild Control Center is the separate web app for workspace management, including analytics, configuration, integrations, and agent setup. Put its entry in the account menu for members who have access. Use the system browser for the handoff from an installed client where the platform supports it.
- Use the existing Guild theme, icons, and shadcn components. Borrow interaction patterns from other products and express them in Guild’s own visual language.

## Sidebar and window toolbar

- Keep the sidebar toggle and back/forward controls in a stable top-left toolbar. The browser or webview owns the navigation history. Collapsing the sidebar gives the content pane the full width. Reopening restores the chat list’s scroll position and expanded sections.
- Use one 44 px toolbar row and align its heading and controls to the same vertical center. Carry the sidebar background through its part of the toolbar. Use the standard foreground for the sidebar toggle. Respect the macOS traffic-light inset and Windows caption controls.
- Use one vertical scroll area for New, Search, Projects, Apps, Scheduled tasks, Customize, and the chat history. Keep the account footer outside that scroller. Allow vertical thumb dragging and show the thumb on window hover when the list overflows. Clip horizontal overflow.
- Keep the right gutter narrow. Place the thin resize indicator at the sidebar’s right edge, outside the scrollbar’s hit area.
- Keep Pinned and Chats and tasks in the history. Put Archived at the bottom. Keep section labels on one line. A separate arrow opens the shadcn history filter. Clicking the heading toggles its section.
- Use matching ghost buttons in the footer. The account button shows the avatar and name. Workspace switching belongs in its menu. The adjacent device icon opens a dedicated setup and pairing dialog. Device management lives in personal Settings.

## Pages and detail views

- Use one bold page heading and the full available content pane. Detail headers use `Section / Item name` on the shared toolbar row, with the section clickable and the item name bold. Use consistent 16 px side gutters. Align the header with the sidebar toolbar when the sidebar is open. Keep the space above the header limited to the platform’s window chrome.
- Put a ghost plus immediately after the heading for create actions. Give icon-only buttons an accessible action label. Put search, filters, and sorting on the row below the heading or inside the relevant tab. Keep secondary commands together in a menu when several are available.
- When a fixed-width label overflows, fade its trailing edge. Let longer content wrap where space permits. Preserve the full text for assistive technology and expose it through a tooltip when useful.
- Use the `text-base` size throughout Guild, including menus, tooltips, and dialogs. Use font weight and muted color to distinguish headings and secondary text. Use existing theme tokens for colors.
- Projects uses a list and opens each project on its own route. Customize is the section and Skills is its tab. Its create action starts a chat with an editable prompt. The desktop composer takes focus when ready.
- Scheduled task details show the schedule, next run, delivery destination, and Markdown prompt as peer settings. Keep the prompt visible below the delivery destination. Run now opens the thread for the run it starts. Each run-history row opens the run and shows only its date and status. Put Run now in the body, with editing and pause or resume in the task actions menu.

## Interaction and checks

- Keep pages, tabs, and dialogs addressable through the Work route model. Back, forward, and reload should restore the visible destination.
- Use the current chat-title search inside the Search dialog. Keep the chat transcript and composer centered as a unit in the usable pane, with sensible gutters when the sidebar is open.
- Check changes at a narrow sidebar width and a mobile width, with the sidebar open and collapsed. Verify keyboard focus, menu triggers, hover states, and long names. Check the native title-bar spacing on each desktop platform affected by a toolbar change.
