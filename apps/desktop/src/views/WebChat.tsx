import { useEffect, useRef, useState } from "react";
import { Button } from "../components/button";
import { Input } from "../components/input";
import { createChat, listModels, streamChat } from "../transport";

interface Block {
  kind: "text" | "user" | "error";
  text: string;
}

/// Web-mode chat view: plain streaming chat through the org gateway.
/// Full agent mode (local project + tools) is the desktop (Tauri) flow.
export default function WebChat({ email, onSignOut }: { email: string; onSignOut: () => void }) {
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState("");
  const [chatId, setChatId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [busy, setBusy] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listModels().then((m) => {
      setModels(m);
      if (m.length > 0) setModel(m[0]);
    });
  }, []);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [blocks]);

  const send = async () => {
    const text = prompt.trim();
    if (!text || busy || !model) return;
    setBusy(true);
    setPrompt("");
    setBlocks((b) => [...b, { kind: "user", text }]);
    let cid = chatId;
    if (!cid) {
      cid = await createChat("Web chat");
      setChatId(cid);
    }
    if (!cid) {
      setBlocks((b) => [...b, { kind: "error", text: "chat create failed" }]);
      setBusy(false);
      return;
    }
    try {
      let acc = "";
      await streamChat(cid, model, text, (ev) => {
        if (ev.type === "delta" && ev.content) {
          acc += ev.content;
          setBlocks((b) => {
            const last = b[b.length - 1];
            if (last?.kind === "text") {
              return [...b.slice(0, -1), { kind: "text", text: acc }];
            }
            return [...b, { kind: "text", text: acc }];
          });
        } else if (ev.type === "error") {
          setBlocks((b) => [...b, { kind: "error", text: ev.message ?? "model error" }]);
        }
      });
    } catch (e) {
      setBlocks((b) => [...b, { kind: "error", text: String(e instanceof Error ? e.message : e) }]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-screen flex-col bg-neutral-950 text-neutral-100">
      <header className="flex items-center justify-between gap-3 border-b border-neutral-800 px-4 py-2 text-sm">
        <span className="font-medium">Guild — {email}</span>
        {models.length > 0 ? (
          <select
            className="h-8 rounded-md border border-neutral-700 bg-neutral-900 px-2 text-xs"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            title="Models enabled on the org gateway"
          >
            {models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        ) : (
          <span className="rounded-md border border-amber-700/60 bg-amber-900/30 px-2 py-1 text-xs text-amber-300">
            no models configured — ask an admin to add a route
          </span>
        )}
        <a
          className="text-xs text-neutral-400 underline decoration-neutral-600 hover:text-neutral-200"
          href="/admin/"
          title="Admin console (same account)"
        >
          Admin console →
        </a>
        <button className="text-xs text-neutral-500 hover:text-neutral-300" onClick={onSignOut}>
          sign out
        </button>
      </header>
      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {blocks.length === 0 && (
          <p className="text-neutral-500">Chat with the org gateway. Agents with local tools are the desktop app's superpower.</p>
        )}
        {blocks.map((b, i) =>
          b.kind === "user" ? (
            <div key={i} className="ml-auto max-w-[80%] rounded-lg bg-neutral-800 px-3 py-2 text-sm">
              {b.text}
            </div>
          ) : b.kind === "error" ? (
            <div key={i} className="max-w-[80%] rounded-lg border border-red-900 bg-red-950/50 px-3 py-2 text-sm text-red-300">
              {b.text}
            </div>
          ) : (
            <div key={i} className="max-w-[80%] whitespace-pre-wrap rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm">
              {b.text}
            </div>
          ),
        )}
        <div ref={bottom} />
      </div>
      <div className="flex gap-2 border-t border-neutral-800 p-3">
        <Input
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && void send()}
          placeholder={model ? "Message…" : "No model available"}
          disabled={busy || !model}
        />
        <Button onClick={() => void send()} disabled={busy || !model}>
          {busy ? "…" : "Send"}
        </Button>
      </div>
    </div>
  );
}
