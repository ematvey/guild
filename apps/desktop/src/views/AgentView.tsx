import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../components/button";
import { Input } from "../components/input";
import { ApprovalModal } from "../components/approval";

interface Block {
  kind: "text" | "user" | "tool_call" | "tool_result" | "done" | "error";
  text: string;
  tool?: string;
  args?: string;
  diff?: string;
}

interface RpcEvent {
  event: string;
  payload: {
    content?: string;
    summary?: string;
    diff?: string;
    error?: string;
    id?: string;
    name?: string;
    arguments?: unknown;
    request_id?: string;
    tool?: string;
    message?: string;
    summary_done?: string;
  };
}

export default function AgentView({ email }: { email: string }) {
  const [projectDir, setProjectDir] = useState<string | null>(null);
  const [model, setModel] = useState<string>("");
  const [models, setModels] = useState<string[] | null>(null);
  const [prompt, setPrompt] = useState("");
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [busy, setBusy] = useState(false);
  const [approval, setApproval] = useState<{ requestId: string; tool: string; args: string } | null>(null);
  const [commandPolicy, setCommandPolicy] = useState<"ask" | "allow" | "never">("ask");
  const unlisten = useRef<UnlistenFn | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const lastText = useRef<number>(-1);

  useEffect(() => {
    // discover enabled models from the org gateway; falls back to free text
    invoke<any>("rpc_request", { method: "models.list", params: {} })
      .then((res) => {
        const list: string[] = res?.models ?? [];
        setModels(list);
        if (list.length > 0) setModel((m) => (list.includes(m) ? m : list[0]));
      })
      .catch(() => setModels([]));
  }, []);

  useEffect(() => {
    listen<RpcEvent>("rpc-event", (e) => {
      const { event, payload } = e.payload;
      if (event === "agent.text" && payload.content) {
        setBlocks((b) => {
          const content = payload.content ?? "";
          if (lastText.current >= 0 && lastText.current === b.length - 1) {
            const copy = [...b];
            copy[lastText.current] = { ...copy[lastText.current], text: copy[lastText.current].text + content };
            return copy;
          }
          lastText.current = b.length;
          return [...b, { kind: "text", text: content }];
        });
      } else if (event === "agent.tool_call") {
        lastText.current = -1;
        setBlocks((b) => [
          ...b,
          {
            kind: "tool_call",
            text: "",
            tool: payload.name,
            args: JSON.stringify(payload.arguments),
          },
        ]);
      } else if (event === "agent.tool_result") {
        lastText.current = -1;
        setBlocks((b) => [
          ...b,
          {
            kind: "tool_result",
            text: payload.error ?? payload.summary ?? payload.content ?? "",
            tool: payload.name,
            diff: payload.diff,
          },
        ]);
      } else if (event === "agent.approval_request") {
        setApproval({
          requestId: payload.request_id!,
          tool: payload.tool!,
          args: JSON.stringify(payload.arguments),
        });
      } else if (event === "agent.done") {
        setBusy(false);
      } else if (event === "agent.error") {
        setBusy(false);
        setBlocks((b) => [...b, { kind: "error", text: payload.message ?? "agent failed" }]);
      } else if (event === "rpc.error") {
        setBusy(false);
        setBlocks((b) => [...b, { kind: "error", text: payload.message ?? "unknown error" }]);
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
  }, [blocks]);

  const pickProject = useCallback(async () => {
    const dir = await open({ directory: true, multiple: false });
    if (typeof dir === "string") setProjectDir(dir);
  }, []);

  const start = useCallback(async () => {
    if (!projectDir || !prompt.trim() || busy) return;
    setBusy(true);
    lastText.current = -1;
    setBlocks((b) => [...b, { kind: "user", text: prompt }]);
    try {
      await invoke("rpc_request", {
        method: "agent.start",
        params: { project_dir: projectDir, prompt, model },
      });
    } catch (e) {
      setBusy(false);
      setBlocks((b) => [...b, { kind: "error", text: String(e) }]);
    }
    setPrompt("");
  }, [projectDir, prompt, busy, model]);

  const decide = useCallback(async (approve: boolean, reason: string) => {
    if (!approval) return;
    setApproval(null);
    try {
      await invoke("rpc_request", {
        method: "agent.approve",
        params: { request_id: approval.requestId, decision: approve ? "approve" : "deny", reason },
      });
    } catch (e) {
      setBlocks((b) => [...b, { kind: "error", text: String(e) }]);
    }
  }, [approval]);

  const setPolicy = useCallback(async (policy: "ask" | "allow" | "never") => {
    setCommandPolicy(policy);
    try {
      await invoke("rpc_request", {
        method: "agent.policy.set",
        params: { tool: "run_command", policy },
      });
    } catch {
      // engine will still ask by default
    }
  }, []);

  return (
    <div className="flex h-screen flex-col bg-neutral-950 text-neutral-100">
      <header className="flex items-center justify-between gap-2 border-b border-neutral-800 px-4 py-2">
        <span className="text-sm font-medium">Guild — {email}</span>
        <Button variant="outline" onClick={pickProject} className="text-xs">
          {projectDir ? projectDir.split("/").pop() : "Open project…"}
        </Button>
        {models !== null && models.length > 0 ? (
          <select
            className="h-9 rounded-md border border-neutral-700 bg-neutral-900 px-2 text-xs"
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
          <span
            className="rounded-md border border-amber-700/60 bg-amber-900/30 px-2 py-1.5 text-xs text-amber-300"
            title="An org admin must add a provider key and a model route in the admin console"
          >
            no models configured — ask an admin to add a route
          </span>
        )}
        <select
          className="h-9 rounded-md border border-neutral-700 bg-neutral-900 px-2 text-xs"
          value={commandPolicy}
          onChange={(e) => setPolicy(e.target.value as typeof commandPolicy)}
        >
          <option value="ask">commands: ask</option>
          <option value="allow">commands: allow</option>
          <option value="never">commands: never</option>
        </select>
      </header>
      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {blocks.length === 0 && (
          <p className="text-sm text-neutral-500">
            Open a project, then give the agent a task. Commands ask for approval by default.
          </p>
        )}
        {blocks.map((b, i) =>
          b.kind === "tool_call" ? (
            <div key={i} className="mr-auto max-w-[80%] rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2 text-xs">
              <span className="font-mono text-amber-300">tool ▶ {b.tool}</span>
              <pre className="mt-1 whitespace-pre-wrap text-neutral-400">{b.args}</pre>
            </div>
          ) : b.kind === "tool_result" ? (
            <div key={i} className="mr-auto max-w-[80%] rounded-lg bg-neutral-900 px-3 py-2 text-xs">
              {b.diff ? (
                <pre className="whitespace-pre-wrap font-mono">
                  {b.diff.split("\n").map((l, j) => (
                    <span key={j} className={l.startsWith("+") ? "text-green-400" : l.startsWith("-") ? "text-red-400" : "text-neutral-500"}>
                      {l}
                      {"\n"}
                    </span>
                  ))}
                </pre>
              ) : (
                <span className="text-neutral-400">{b.tool}: {b.text}</span>
              )}
            </div>
          ) : (
            <div
              key={i}
              className={
                b.kind === "user"
                  ? "ml-auto max-w-[70%] rounded-lg bg-neutral-800 px-3 py-2"
                  : b.kind === "error"
                    ? "rounded-lg bg-red-950 px-3 py-2 text-sm text-red-300"
                    : "mr-auto max-w-[70%] whitespace-pre-wrap rounded-lg bg-neutral-900 px-3 py-2"
              }
            >
              {b.text}
            </div>
          ),
        )}
        <div ref={bottom} />
      </div>
      <div className="flex gap-2 border-t border-neutral-800 p-3">
        <Input
          value={prompt}
          placeholder={projectDir ? "Describe a task…" : "Open a project first…"}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && start()}
          disabled={!projectDir || (models !== null && models.length === 0)}
        />
        <Button onClick={start} disabled={busy || !projectDir || (models !== null && models.length === 0)}>
          {busy ? "Working…" : "Run"}
        </Button>
      </div>
      {approval && (
        <ApprovalModal
          tool={approval.tool}
          args={approval.args}
          onDecide={decide}
        />
      )}
    </div>
  );
}
