// The App host: frames the App's page from its signed link and answers the
// page's bridge messages (bridge.ts). A message counts only from this
// frame's window. A function that changes data asks the viewer first, in
// Guild's own dialog, outside the page's reach.

import { useEffect, useRef, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@guild/ui/components/alert-dialog";
import { apiUrl } from "../../lib/session";
import { Button } from "@guild/ui/components/button";
import { callAppFunction, getAppPageLink, type ConfirmAnswer, type ViewerFunction } from "./apps-api";
import { answerCall, initMessage, parsePageMessage, requestLine, sharedConfirm } from "./bridge";

type Theme = "light" | "dark";

const currentTheme = (): Theme => (document.documentElement.classList.contains("dark") ? "dark" : "light");

/** The app's light/dark theme, following the `dark` class on <html>. */
function useDocumentTheme(): Theme {
  const [theme, setTheme] = useState<Theme>(currentTheme);
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(currentTheme()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  return theme;
}

interface PendingConfirm {
  fn: ViewerFunction;
  params: unknown;
  resolve: (answer: ConfirmAnswer) => void;
}

export function AppFrame({
  app,
  functions,
}: {
  app: { id: string; name: string; version: number };
  functions: ViewerFunction[];
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Open questions, oldest first: one per function (sharedConfirm), shown
  // one at a time.
  const [queue, setQueue] = useState<PendingConfirm[]>([]);
  const pending = queue[0] ?? null;
  // Functions the viewer chose "always allow" for while this frame is open.
  const granted = useRef(new Set<string>());
  const confirm = useRef(
    sharedConfirm(
      (fn, params) => new Promise<ConfirmAnswer>((resolve) => setQueue((open) => [...open, { fn, params, resolve }])),
    ),
  );
  const theme = useDocumentTheme();
  const latest = useRef({ app, functions, theme });
  latest.current = { app, functions, theme };

  useEffect(() => {
    let dead = false;
    setSrc(null);
    setError(null);
    getAppPageLink(app.id)
      .then((link) => {
        if (!dead) setSrc(apiUrl(link.path));
      })
      .catch((e: unknown) => {
        if (!dead) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      dead = true;
    };
  }, [app.id, app.version]);

  useEffect(() => {
    const post = (message: unknown) => frame.current?.contentWindow?.postMessage(message, "*");
    const onMessage = (event: MessageEvent) => {
      const win = frame.current?.contentWindow;
      if (win === null || win === undefined || event.source !== win) return;
      const message = parsePageMessage(event.data);
      if (message === null) return;
      const { app: current, functions: fns, theme: shown } = latest.current;
      if (message.op === "hello") {
        post(initMessage(current, fns, shown));
        return;
      }
      void answerCall(message, {
        functions: fns.map((fn) => (granted.current.has(fn.name) ? { ...fn, granted: true } : fn)),
        confirm: confirm.current,
        call: (name, params, confirmed, remember) => callAppFunction(current.id, name, params, confirmed, remember),
        granted: (name) => granted.current.add(name),
      }).then(post);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    frame.current?.contentWindow?.postMessage({ guild: 1, op: "theme", theme }, "*");
  }, [theme]);

  const settle = (answer: ConfirmAnswer) => {
    pending?.resolve(answer);
    setQueue((open) => open.slice(1));
  };

  if (error !== null) {
    return (
      <div role="alert" className="flex h-full items-center justify-center p-6 text-sm text-destructive">
        {error}
      </div>
    );
  }
  return (
    <>
      {src === null ? (
        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Opening…</div>
      ) : (
        <iframe
          ref={frame}
          key={src}
          src={src}
          title={app.name}
          sandbox="allow-scripts allow-forms allow-modals"
          referrerPolicy="no-referrer"
          className="h-full w-full border-0 bg-background"
        />
      )}
      <AlertDialog open={pending !== null} onOpenChange={(open) => !open && settle("decline")}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Allow {app.name} to use {pending?.fn.integration}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pending?.fn.description || pending?.fn.name}. It calls{" "}
              <span className="font-mono">{pending?.fn.tool}</span> as you, a tool that can change data, so Guild asks
              first.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {pending !== null && (
            <div className="space-y-2">
              <p className="font-mono text-xs">{requestLine(pending.fn)}</p>
              <pre className="max-h-48 overflow-auto rounded-md bg-muted p-3 font-mono text-xs">
                {JSON.stringify(pending.params, null, 2)}
              </pre>
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Decline</AlertDialogCancel>
            <Button variant="outline" onClick={() => settle("once")}>
              Allow once
            </Button>
            <AlertDialogAction onClick={() => settle("always")}>Always allow for this app</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
