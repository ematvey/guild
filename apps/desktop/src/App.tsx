import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Button } from "./components/button";
import { Input } from "./components/input";
import { Card, CardContent, CardHeader, CardTitle } from "./components/card";

interface DeltaEvent {
  event: string;
  payload: { content?: string; cost_usd?: number; tokens_in?: number; tokens_out?: number; message?: string };
}

function Login({ onLoggedIn }: { onLoggedIn: (email: string) => void }) {
  const [url, setUrl] = useState("http://localhost:18080");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await invoke("start_engine");
      const res = await invoke<any>("rpc_request", {
        method: "login",
        params: { base_url: url, email, password },
      });
      if (res.error) {
        setError(res.error.message ?? "login failed");
      } else {
        onLoggedIn(res.result?.user?.email ?? email);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-neutral-950 text-neutral-100">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">Guild</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Input placeholder="Server URL" value={url} onChange={(e) => setUrl(e.target.value)} />
          <Input placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <Input
            placeholder="Password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
          {error && <p className="text-sm text-red-400">{error}</p>}
          <Button onClick={submit} disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

function Chat({ email }: { email: string }) {
  const [messages, setMessages] = useState<{ role: string; content: string }[]>([]);
  const [draft, setDraft] = useState("");
  const [model, setModel] = useState("gpt-4o-mini");
  const [busy, setBusy] = useState(false);
  const unlisten = useRef<UnlistenFn | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listen<DeltaEvent>("rpc-event", (e) => {
      const { event, payload } = e.payload;
      if (event === "chat.delta" && payload.content) {
        setMessages((m) => [...m.slice(0, -1), { role: "assistant", content: payload.content! }]);
      } else if (event === "chat.done") {
        setBusy(false);
      } else if (event === "rpc.error") {
        setMessages((m) => [...m, { role: "system", content: `error: ${payload.message ?? "?"}` }]);
        setBusy(false);
      }
    }).then((u) => {
      unlisten.current = u;
    });
    return () => {
      unlisten.current?.();
    };
  }, []);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || busy) return;
    setDraft("");
    setMessages((m) => [...m, { role: "user", content: text }, { role: "assistant", content: "…" }]);
    setBusy(true);
    try {
      await invoke("rpc_request", { method: "chat.send", params: { text, model } });
    } catch (e) {
      setMessages((m) => [...m, { role: "system", content: `error: ${String(e)}` }]);
      setBusy(false);
    }
  }, [draft, busy, model]);

  return (
    <div className="flex h-screen flex-col bg-neutral-950 text-neutral-100">
      <header className="flex items-center justify-between border-b border-neutral-800 px-4 py-2">
        <span className="text-sm font-medium">Guild — {email}</span>
        <Input
          className="w-48 text-xs"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder="model"
        />
      </header>
      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {messages.map((m, i) => (
          <div
            key={i}
            className={
              m.role === "user"
                ? "ml-auto max-w-[70%] rounded-lg bg-neutral-800 px-3 py-2"
                : "mr-auto max-w-[70%] rounded-lg bg-neutral-900 px-3 py-2 whitespace-pre-wrap"
            }
          >
            {m.content}
          </div>
        ))}
        <div ref={bottom} />
      </div>
      <div className="flex gap-2 border-t border-neutral-800 p-3">
        <Input
          value={draft}
          placeholder="Message…"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
        />
        <Button onClick={send} disabled={busy}>
          Send
        </Button>
      </div>
    </div>
  );
}

export default function App() {
  const [email, setEmail] = useState<string | null>(null);
  useEffect(() => {
    invoke("start_engine").catch(() => {});
  }, []);
  return email ? <Chat email={email} /> : <Login onLoggedIn={setEmail} />;
}
