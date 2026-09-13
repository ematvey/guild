import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUp, Bot, FolderOpen, Wrench } from "lucide-react";

import { ApprovalModal } from "@guild/ui/components/approval";
import { Button } from "@guild/ui/components/button";
import { Caret } from "@guild/ui/components/caret";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@guild/ui/components/select";
import { Separator } from "@guild/ui/components/separator";
import { Skeleton } from "@guild/ui/components/skeleton";
import { Spinner } from "@guild/ui/components/spinner";
import { Textarea } from "@guild/ui/components/textarea";
import { ThemeToggle } from "../App";
import { rpcCall } from "../transport";

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

/// Desktop (Tauri) agent view: same design language as the web chat, but the
/// conversation is an agent run against a local project (tools, approvals).
export default function AgentView({ email, adminUrl }: { email: string; adminUrl?: string | null }) {
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
  const ta = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    // discover enabled models from the org gateway; falls back to free text
    rpcCall("models.list", {})
      .then((res) => {
        const list: string[] = res?.result?.models ?? [];
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

  const autoGrow = () => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  };

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
      await rpcCall("agent.start", { project_dir: projectDir, prompt, model });
    } catch (e) {
      setBusy(false);
      setBlocks((b) => [...b, { kind: "error", text: String(e) }]);
    }
    setPrompt("");
    if (ta.current) ta.current.style.height = "auto";
  }, [projectDir, prompt, busy, model]);

  const decide = useCallback(async (approve: boolean, reason: string) => {
    if (!approval) return;
    setApproval(null);
    try {
      await rpcCall("agent.approve", { request_id: approval.requestId, decision: approve ? "approve" : "deny", reason });
    } catch (e) {
      setBlocks((b) => [...b, { kind: "error", text: String(e) }]);
    }
  }, [approval]);

  const setPolicy = useCallback(async (policy: "ask" | "allow" | "never") => {
    setCommandPolicy(policy);
    try {
      await rpcCall("agent.policy.set", { tool: "execute", policy });
    } catch {
      // engine will still ask by default
    }
  }, []);

  const noModels = models !== null && models.length === 0;
  const canRun = !!projectDir && !busy && !noModels;

  return (
    <div className="fixed inset-0 flex bg-background text-foreground">
      {/* sidebar */}
      <aside className="flex w-64 shrink-0 flex-col border-r border-border bg-card">
        <div className="flex items-center justify-between px-3 py-3">
          <span className="text-base font-semibold">Guild</span>
          <ThemeToggle />
        </div>
        <div className="px-3 pb-1 pt-2 text-xs font-medium text-muted-foreground">Project</div>
        <div className="px-2">
          <button
            onClick={pickProject}
            className="flex w-full items-start gap-2 rounded-md px-2 py-2 text-left outline-none transition-colors hover:bg-accent"
            title={projectDir ?? "Choose a project directory"}
          >
            <FolderOpen className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-base">
                {projectDir ? projectDir.split("/").pop() || projectDir : "Open project…"}
              </span>
              {projectDir && (
                <span className="block truncate text-xs text-muted-foreground" title={projectDir}>
                  {projectDir}
                </span>
              )}
            </span>
          </button>
        </div>
        <div className="min-h-0 flex-1" />
        <Separator />
        <div className="flex items-center gap-2.5 px-3 py-3">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground">
            {email.slice(0, 2).toUpperCase()}
          </span>
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={email}>
            {email}
          </span>
          {adminUrl && (
            <a
              href={adminUrl}
              target="_blank"
              rel="noreferrer"
              className="shrink-0 text-xs text-muted-foreground outline-none hover:text-foreground"
              title="Open the admin console in your browser"
            >
              ↗
            </a>
          )}
        </div>
      </aside>

      {/* main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-2 border-b border-border px-3 py-2.5 text-base">
          <span className="min-w-0 flex-1 truncate font-medium">
            {projectDir ? projectDir.split("/").pop() || projectDir : "Guild agent"}
          </span>
          {busy && <Spinner />}
        </header>

        {blocks.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center overflow-y-auto px-4 py-8">
            <div className="flex size-14 shrink-0 items-center justify-center rounded-2xl border border-border bg-card">
              <Bot className="size-7 text-muted-foreground" />
            </div>
            <h1 className="mt-6 text-center text-2xl font-semibold tracking-tight">
              {projectDir ? (
                <>
                  What should we work on in{" "}
                  <span className="underline decoration-border underline-offset-4">
                    {projectDir.split("/").pop() || projectDir}
                  </span>
                  ?
                </>
              ) : (
                "Open a project to begin"
              )}
            </h1>
            <p className="mt-2 max-w-md text-center text-base text-muted-foreground">
              The agent works directly in your project — reading and editing files, running commands
              {commandPolicy === "ask" ? " (with your approval)" : ""}.{" "}
              {noModels
                ? "No models are configured yet — ask an org admin to add a route."
                : "Pick a project, then describe a task below."}
            </p>
            {!projectDir && (
              <Button className="mt-8" onClick={pickProject}>
                <FolderOpen /> Open project…
              </Button>
            )}
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            <div className="mx-auto w-full max-w-3xl space-y-4 px-4 py-6">
              {blocks.map((b, i) =>
                b.kind === "tool_call" ? (
                  <div key={i} className="mr-auto w-fit max-w-[85%] rounded-lg border border-border bg-card px-3 py-2 text-xs">
                    <span className="inline-flex items-center gap-1.5 font-mono text-amber-600 dark:text-amber-400">
                      <Wrench className="size-3.5" /> {b.tool}
                    </span>
                    <pre className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap text-muted-foreground">{b.args}</pre>
                  </div>
                ) : b.kind === "tool_result" ? (
                  <div key={i} className="mr-auto w-fit max-w-[85%] rounded-lg border border-border bg-card px-3 py-2 text-xs">
                    {b.diff ? (
                      <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap font-mono">
                        {b.diff.split("\n").map((l, j) => (
                          <span
                            key={j}
                            className={
                              l.startsWith("+")
                                ? "text-emerald-600 dark:text-emerald-400"
                                : l.startsWith("-")
                                  ? "text-red-600 dark:text-red-400"
                                  : "text-muted-foreground"
                            }
                          >
                            {l}
                            {"\n"}
                          </span>
                        ))}
                      </pre>
                    ) : (
                      <span className="text-muted-foreground">
                        <span className="font-mono">{b.tool}</span>: {b.text}
                      </span>
                    )}
                  </div>
                ) : b.kind === "user" ? (
                  <div key={i} className="ml-auto w-fit max-w-[80%] rounded-2xl bg-secondary px-4 py-2.5 text-base">
                    {b.text}
                  </div>
                ) : b.kind === "error" ? (
                  <div
                    key={i}
                    className="w-fit rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-base text-destructive"
                  >
                    {b.text}
                  </div>
                ) : (
                  <div key={i} className="mr-auto w-fit max-w-[85%] whitespace-pre-wrap text-base leading-relaxed">
                    {b.text}
                    {busy && i === blocks.length - 1 && <Caret />}
                  </div>
                ),
              )}
              {busy && blocks[blocks.length - 1]?.kind !== "text" && (
                <div className="mr-auto w-fit max-w-[85%] text-base">
                  <Caret />
                </div>
              )}
              <div ref={bottom} />
            </div>
          </div>
        )}

        {/* composer */}
        <div className="p-3 sm:p-4">
          <div className="mx-auto w-full max-w-3xl rounded-2xl border border-border bg-card p-2 shadow-sm">
            <Textarea
              ref={ta}
              value={prompt}
              onChange={(e) => {
                setPrompt(e.target.value);
                autoGrow();
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void start();
                }
              }}
              rows={1}
              placeholder={
                noModels
                  ? "No model available"
                  : projectDir
                    ? "Describe a task…"
                    : "Open a project first…"
              }
              disabled={busy || !projectDir || noModels}
              className="max-h-40 resize-none border-0 bg-transparent px-2 py-1.5 shadow-none "
            />
            <div className="flex items-center justify-between gap-2 px-1 pt-1">
              <div className="flex min-w-0 items-center gap-1.5">
              {models !== null && models.length === 0 && (
                <span className="text-xs text-muted-foreground">no models configured</span>
              )}
              {models === null && <Skeleton className="h-7 w-28 rounded-md" />}
              <Select value={commandPolicy} onValueChange={(v) => void setPolicy(v as typeof commandPolicy)}>
                <SelectTrigger
                  className="h-7 w-auto gap-1 border-none bg-secondary px-2 text-xs shadow-none"
                  title={`Shell commands run by the agent ${commandPolicy === "ask" ? "ask for approval" : commandPolicy === "allow" ? "run without asking" : "are denied"}`}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ask" className="text-xs">commands: ask</SelectItem>
                  <SelectItem value="allow" className="text-xs">commands: allow</SelectItem>
                  <SelectItem value="never" className="text-xs">commands: never</SelectItem>
                </SelectContent>
              </Select>
              </div>
              <div className="flex items-center gap-2">
                {models !== null && models.length > 0 && (
                  <Select value={model} onValueChange={setModel}>
                    <SelectTrigger className="h-7 w-auto gap-1 border-none bg-secondary px-2 text-xs shadow-none">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {models.map((m) => (
                        <SelectItem key={m} value={m} className="text-xs">
                          {m}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                <Button
                  size="icon"
                  className="size-7 rounded-full"
                  onClick={() => void start()}
                  disabled={!canRun || !prompt.trim()}
                  title="Run"
                >
                  {busy ? <Spinner className="text-primary-foreground" /> : <ArrowUp />}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {approval && <ApprovalModal tool={approval.tool} args={approval.args} onDecide={decide} />}
    </div>
  );
}
