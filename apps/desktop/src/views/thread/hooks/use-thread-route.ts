// URL-driven navigation state for the thread view: the pathname is the
// single source of truth, and every navigation pushes history and route state
// together.
import { useEffect, useState } from "react";
import { applyRoutePatch, chatRoutePath, parseChatRoute, type ChatRoute, type RoutePatch } from "../route";


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
    if (current !== path) window.history.pushState(null, "", path);
    setRoute(resolved);
  };

  return { route, setRoute, pushRoute };
}
