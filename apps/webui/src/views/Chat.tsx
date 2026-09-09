import { useCallback, useEffect, useRef, useState } from "react";
import { api, streamChat } from "../api";
import { Button } from "../components/button";
import { Input } from "../components/input";

interface ChatRow {
  id: string;
  title?: string | null;
}

interface Msg {
  role: string;
  content: string;
  cost?: string;
}

export default function Chat() {
  const [chats, setChats] = useState<ChatRow[]>([]);
  const [activeChat, setActiveChat] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [draft, setDraft] = useState("");
  const [model, setModel] = useState("gpt-4o-mini");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  const reloadChats = useCallback(() => {
    api<{ chats: ChatRow[] }>("GET", "/api/v1/chats")
      .then((r) => setChats(r.chats))
      .catch((e: unknown) => setError(String(e instanceof Error ? e.message : e)));
  }, []);

  useEffect(reloadChats, [reloadChats]);

  const openChat = useCallback(async (id: string) => {
    setActiveChat(id);
    setError(null);
    try {
      const r = await api<{ messages: Msg[] }>("GET", `/api/v1/chats/${id}/messages`);
      setMessages(r.messages.map((m) => ({ role: m.role, content: m.content })));
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  }, []);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const newChat = async () => {
    try {
      const r = await api<{ id: string }>("POST", "/api/v1/chats", { title: "web chat" });
      reloadChats();
      setActiveChat(r.id);
      setMessages([]);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  };

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || busy || !activeChat) return;
    setDraft("");
    setBusy(true);
    setMessages((m) => [...m, { role: "user", content: text }, { role: "assistant", content: "" }]);
    try {
      await streamChat(activeChat, model, text, (ev) => {
        const t = ev["type"];
        if (t === "delta") {
          const content = (ev as { content?: string }).content ?? "";
          setMessages((m) => {
            const copy = [...m];
            copy[copy.length - 1] = { ...copy[copy.length - 1], content: copy[copy.length - 1].content + content };
            return copy;
          });
        } else if (t === "done") {
          const cost = (ev as { cost_usd?: number }).cost_usd ?? 0;
          setMessages((m) => {
            const copy = [...m];
            copy[copy.length - 1] = { ...copy[copy.length - 1], cost: `$${cost.toFixed(6)}` };
            return copy;
          });
          setBusy(false);
        } else if (t === "error") {
          setMessages((m) => [...m.slice(0, -1), { role: "error", content: String(ev["message"] ?? "stream error") }]);
          setBusy(false);
        }
      });
      setBusy(false);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
      setBusy(false);
    }
  }, [draft, busy, activeChat, model]);

  return (
    <div className="flex h-[calc(100vh-42px)]">
      <aside className="w-56 space-y-2 overflow-y-auto border-r border-neutral-800 p-3 text-sm">
        <Button variant="outline" className="w-full text-xs" onClick={newChat}>
          New chat
        </Button>
        {chats.map((c) => (
          <button
            key={c.id}
            className={`block w-full truncate rounded px-2 py-1 text-left text-xs ${activeChat === c.id ? "bg-neutral-800" : "text-neutral-500 hover:text-neutral-300"}`}
            onClick={() => openChat(c.id)}
          >
            {c.title || c.id.slice(0, 8)}
          </button>
        ))}
      </aside>
      <div className="flex flex-1 flex-col">
        <div className="flex-1 space-y-3 overflow-y-auto p-4">
          {error && <p className="text-sm text-red-400">{error}</p>}
          {messages.length === 0 && <p className="text-sm text-neutral-500">Pick or create a chat, then send a message.</p>}
          {messages.map((m, i) => (
            <div
              key={i}
              className={
                m.role === "user"
                  ? "ml-auto max-w-[70%] rounded-lg bg-neutral-800 px-3 py-2"
                  : m.role === "error"
                    ? "rounded-lg bg-red-950 px-3 py-2 text-sm text-red-300"
                    : "mr-auto max-w-[70%] whitespace-pre-wrap rounded-lg bg-neutral-900 px-3 py-2"
              }
            >
              {m.content}
              {m.cost && <span className="ml-2 text-xs text-neutral-500">{m.cost}</span>}
            </div>
          ))}
          <div ref={bottom} />
        </div>
        <div className="flex gap-2 border-t border-neutral-800 p-3">
          <Input className="w-40 text-xs" value={model} onChange={(e) => setModel(e.target.value)} placeholder="model" />
          <Input
            value={draft}
            placeholder={activeChat ? "Message…" : "Pick or create a chat first"}
            disabled={!activeChat}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && send()}
          />
          <Button onClick={send} disabled={busy || !activeChat}>
            Send
          </Button>
        </div>
      </div>
    </div>
  );
}
