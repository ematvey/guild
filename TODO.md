# TODO

Future tasks. Newest on top. Move items to PLAN.md entries when they land.

## Split `apps/desktop/src/views/WebChat.tsx`

The file is 4907 lines and holds three things: the route model and pure
helpers, the app shell, and the thread view. `WebChat` is also the wrong name
— it renders a thread, and the route is `/thread/<id>`.

Mechanical, no behaviour change. Do it in its own branch, not while a feature
is in flight, because every import path moves and it conflicts with any
session editing those files.

1. `views/thread/route.ts` — `ChatRoute`, `parseChatRoute`, `chatRoutePath`,
   `pushRoute`.
2. `views/thread/thread-helpers.ts` — `isReadOnlyThread`, `toolLabel`,
   `toolDisplayName`, `composerSkills`, `mentionCandidates`, `tabPaneLayout`,
   `busyAfterThreadPush`, `sendButtonState`, `pruneStopping`, `statusFromThreads`,
   `offlineMachine`, `accountDefaultLabel`, `parseSearchResults`, `compareVersions`.
3. `views/thread/thread-view.tsx` — the component, renamed from `WebChat.tsx`.
4. Split `WebChat.pure.test.ts` (1124 lines) along the same lines.
5. Leave the shell extraction (sidebar wiring, overlays, settings entry
   points) for later — it needs a design pass, not a file move.

Consumers that move with it: `App.tsx`, `views/sidebar-contents.tsx`,
`views/onboarding.tsx`, `views/skills/SkillsPanel.tsx`,
`views/settings/sections/round3.test.ts`, `lib/outgoing-command.test.ts`.
