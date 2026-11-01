// URL-driven navigation state for the thread view: the pathname is the
// single source of truth, and every navigation pushes history and route state
// together.
import { useCallback, useEffect, useRef, useState } from "react";
import { applyRoutePatch, chatRoutePath, parseChatRoute, type ChatRoute, type RoutePatch } from "../route";

export interface RouteNavOptions {
  /** Rewrite the current history entry instead of adding one: a normalising
   *  redirect is not a step the reader can go back to. */
  replace?: boolean;
}

export type PushRoute = (next: RoutePatch, options?: RouteNavOptions) => void;

/** The address a resolved route lives at. */
export function routePath(resolved: ChatRoute): string {
  return chatRoutePath(
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
}

/** Applies one navigation to the history stack: a new entry, or a rewrite of
 *  the current one. An unchanged address writes nothing. */
export function commitRoute(
  history: Pick<History, "pushState" | "replaceState">,
  current: string,
  resolved: ChatRoute,
  options?: RouteNavOptions,
): void {
  const path = routePath(resolved);
  if (current === path) return;
  if (options?.replace) history.replaceState(null, "", path);
  else history.pushState(null, "", path);
}

export function useThreadRoute() {
  const [route, setRoute] = useState<ChatRoute>(() =>
    parseChatRoute(window.location.pathname, window.location.search),
  );
  // The route every navigation patches. A push writes it before React
  // re-renders, so two navigations in one handler compose.
  const routeRef = useRef(route);
  routeRef.current = route;
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
  // together, so the URL always reflects what is on screen. The function is
  // stable, so callbacks built on it keep their identity across renders.
  const pushRoute = useCallback<PushRoute>((next, options) => {
    const resolved = applyRoutePatch(routeRef.current, next);
    commitRoute(
      window.history,
      `${window.location.pathname}${window.location.search}`,
      resolved,
      options,
    );
    routeRef.current = resolved;
    setRoute(resolved);
  }, []);

  return { route, setRoute, pushRoute };
}
