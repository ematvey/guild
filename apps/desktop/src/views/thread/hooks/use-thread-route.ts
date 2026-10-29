// URL-driven navigation state for the thread view: the pathname is the
// single source of truth, and every navigation pushes history and route state
// together.
//
// Back is part of the same job. The iOS back gesture belongs to the webview:
// it pops a history entry, and this router writes one entry per screen, so a
// swipe would walk the app exactly like a browser walks pages. A guard entry
// sits on top of the stack instead. A back gesture pops the guard, the app
// runs its own move (close the drawer, step up a level) and the guard goes
// back. The Navigation API cannot help: a traversal fires `navigate` but
// cannot be cancelled, so the gesture still moves the history.
import { useEffect, useState } from "react";
import { applyRoutePatch, chatRoutePath, parseChatRoute, type ChatRoute, type RoutePatch } from "../route";
import { IS_TAURI } from "../../../lib/session";

interface GuardState {
  guildGuard?: string;
}

/** The guard this document pushed. Entries left by an earlier page load
 *  carry their own token and never pass for the current one. */
let token: string | null = null;

/** True when `state` is this document's guard entry. */
function isOurGuard(state: unknown): boolean {
  return token !== null && (state as GuardState | null)?.guildGuard === token;
}

/** Puts the guard back on top. Call after every in-app navigation: the
 *  router pushes a screen entry, which would otherwise sit above it. */
export function armBackGuard(): void {
  if (isOurGuard(history.state)) return;
  token = crypto.randomUUID();
  history.pushState({ guildGuard: token } satisfies GuardState, "");
}

/** Installs the back handler. `intent` runs the app's own move — close the
 *  drawer, step up a level. The gesture never leaves the app: a phone closes
 *  it with the Home gesture, and an accidental swipe must not drop the
 *  conversation. */
export function installBackGuard(intent: () => void): () => void {
  armBackGuard();
  const onPop = (event: PopStateEvent): void => {
    // `event.state` is the destination entry; `history.state` still reads the
    // one we left while the handler runs.
    if (isOurGuard(event.state)) return;
    // The guard was consumed: hold the URL where it is and let the app move.
    event.stopImmediatePropagation();
    token = null;
    intent();
    armBackGuard();
  };
  window.addEventListener("popstate", onPop, true);
  return () => window.removeEventListener("popstate", onPop, true);
}



export function useThreadRoute() {
  const [route, setRoute] = useState<ChatRoute>(() =>
    parseChatRoute(window.location.pathname, window.location.search),
  );
  // A malformed escape parses to the default route; the address is rewritten
  // to match, so reload and back/forward do not land on the broken one again.
  useEffect(() => {
    if (route.invalid) window.history.replaceState(null, "", "/chats");
  }, [route.invalid]);
  // Browser back/forward: re-derive the whole route from the URL. The
  // chatId effect takes care of (re)loading or clearing the thread, and the
  // settings/device surfaces follow the parsed route.
  useEffect(() => {
    const onPop = () =>
      setRoute(parseChatRoute(window.location.pathname, window.location.search));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // Every navigation goes through here: history and route state move
  // together, so the URL always reflects what is on screen.
  const pushRoute = (next: RoutePatch) => {
    const resolved = applyRoutePatch(route, next);
    const path = chatRoutePath(
      resolved.chatId,
      resolved.projectId,
      resolved.overlay,
      resolved.skills,
      resolved.tab,
      resolved.settingsSection,
      resolved.settingsDetail,
      resolved.newChat,
      resolved.agents,
      resolved.usage,
    );
    const current = `${window.location.pathname}${window.location.search}`;
    if (current !== path) {
      window.history.pushState(null, "", path);
      // The guard must stay on top of the entry just pushed, or the next back
      // gesture would pop this screen instead of asking the app.
      if (!IS_TAURI) armBackGuard();
    }
    setRoute(resolved);
  };

  return { route, setRoute, pushRoute };
}
