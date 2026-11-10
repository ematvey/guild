import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, ArrowRight, Check, Loader2, Plus } from "lucide-react";
import { Button } from "@guild/ui/components/button";
import { Input } from "@guild/ui/components/input";
import { Skeleton } from "@guild/ui/components/skeleton";
import { Textarea } from "@guild/ui/components/textarea";
import { modelLabel } from "../../lib/api/models";
import { useModelOptions } from "./agent-model";
import {
  SAFE_BASELINE_NAMES,
  SAFE_BASELINE_TOOLS,
  createAgent,
  groupTools,
  listAgentTools,
  type Agent,
  type AgentToolInfo,
  type CreateAgentInput,
} from "./agents-api";
import type { AgentsRoute, CreateStep } from "./agents-route";
import { ErrorState, PageBody } from "./agent-ui";
import { PageHeader } from "../../components/page-header";

type Step = CreateStep;

const STEPS: ReadonlyArray<readonly [Step, string, string]> = [
  ["name", "Name", "Give the agent a short, unique name."],
  ["model", "Model", "Pick one model from the organization catalog."],
  ["tools", "Tools", "Choose the tools this agent may use."],
];

export function validateAgentStep(
  step: Step,
  value: {
    name: string;
    description: string;
    model: string;
    tools: string[];
    toolsMode: "selected" | "all";
  },
): string | null {
  switch (step) {
    case "name":
      if (value.name.trim() === "") return "Enter a name.";
      if (value.name.trim().length > 80) return "Use 80 characters or fewer.";
      if (value.description.trim().length > 500)
        return "Use 500 characters or fewer.";
      return null;
    case "model":
      return value.model === "" ? "Pick a model." : null;
    case "tools":
      return value.toolsMode === "selected" && value.tools.length === 0
        ? "Select at least one tool."
        : null;
  }
}

/** The step the wizard shows for a requested step: a deep link or reload
 *  past an unfinished step (the form lives only in this page) lands on the
 *  first step that still needs input. */
export function reachableStep(
  requested: Step,
  value: Parameters<typeof validateAgentStep>[1],
): Step {
  for (const [id] of STEPS) {
    if (id === requested) return id;
    if (validateAgentStep(id, value) !== null) return id;
  }
  return requested;
}

/** The create request. The description is optional and trimmed; the name
 *  step caps it at 500 characters. A new agent starts private: who may reach
 *  it is its Settings tab's Access list. */
export function createAgentPayload(value: {
  name: string;
  description: string;
  model: string;
  tools: string[];
  toolsMode: "selected" | "all";
}): CreateAgentInput {
  return {
    name: value.name.trim(),
    description: value.description.trim(),
    model: value.model,
    tools: value.tools,
    tools_mode: value.toolsMode,
  };
}

export function AgentCreate({
  step: requestedStep,
  onNavigate,
  onCreated,
}: {
  /** The step the URL names. */
  step: Step;
  onNavigate: (route: AgentsRoute, options?: { replace?: boolean }) => void;
  onCreated?: (agent: Agent) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [model, setModel] = useState("");
  const [tools, setTools] = useState<string[]>(SAFE_BASELINE_NAMES);
  const [toolsMode, setToolsMode] = useState<"selected" | "all">("selected");
  const models = useModelOptions();
  const [catalog, setCatalog] = useState<AgentToolInfo[] | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    void listAgentTools()
      .then((rows) => setCatalog(rows.length > 0 ? rows : SAFE_BASELINE_TOOLS))
      .catch(() => setCatalog(SAFE_BASELINE_TOOLS));
  }, []);

  useEffect(() => {
    if (models !== null && models.length > 0)
      setModel((current) => current || models[0]!.id);
  }, [models]);

  const groups = useMemo(
    () => groupTools(catalog ?? SAFE_BASELINE_TOOLS),
    [catalog],
  );
  const form = { name, description, model, tools, toolsMode };
  const step = reachableStep(requestedStep, form);
  const stepIndex = STEPS.findIndex(([id]) => id === step);
  const currentError = validateAgentStep(step, form);

  // A deep link or reload past an unfinished step shows the first step that
  // still needs input; the URL is replaced to name it, so the address, the
  // page and back/forward agree.
  useEffect(() => {
    if (step !== requestedStep)
      onNavigate({ view: "new", step }, { replace: true });
  }, [step, requestedStep, onNavigate]);

  const go = (next: Step) => {
    setError(null);
    onNavigate({ view: "new", step: next });
  };
  const back = () => {
    if (stepIndex === 0) {
      onNavigate({ view: "directory" });
      return;
    }
    go(STEPS[stepIndex - 1]![0]);
  };
  const next = () => {
    if (currentError !== null) {
      setError(currentError);
      return;
    }
    if (stepIndex < STEPS.length - 1) {
      go(STEPS[stepIndex + 1]![0]);
      return;
    }
    void submit();
  };

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const agent = await createAgent(
        createAgentPayload({ name, description, model, tools, toolsMode }),
      );
      onCreated?.(agent);
      onNavigate({ view: "agent", agentId: agent.id, tab: "overview" });
    } catch (err) {
      setCatalogError(null);
      setError(
        err instanceof Error ? err.message : "Could not create the agent.",
      );
      setSubmitting(false);
    }
  };

  const toggleTool = (toolName: string) => {
    setTools((current) =>
      current.includes(toolName)
        ? current.filter((n) => n !== toolName)
        : [...current, toolName],
    );
  };
  const allTools = catalog ?? SAFE_BASELINE_TOOLS;

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col">
      <PageHeader
        variant="bar"
        title="Create agent"
        description={`Step ${stepIndex + 1} of ${STEPS.length} · ${STEPS[stepIndex]![1]}`}
        actions={
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onNavigate({ view: "directory" })}
          >
            Cancel
          </Button>
        }
      />
      <PageBody className="max-w-[52rem]">
        <ol className="mb-6 flex flex-wrap gap-1.5" aria-label="Creation steps">
          {STEPS.map(([id, label], i) => {
            const done = i < stepIndex;
            const current = id === step;
            return (
              <li key={id} className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => {
                    if (i <= stepIndex) go(id);
                  }}
                  disabled={i > stepIndex}
                  className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors ${
                    current
                      ? "border-foreground bg-foreground text-background"
                      : done
                        ? "border-border bg-secondary text-foreground"
                        : "border-border text-muted-foreground"
                  } ${i <= stepIndex ? "" : "opacity-60"}`}
                >
                  {done ? (
                    <Check className="size-3" />
                  ) : (
                    <span className="font-mono">{i + 1}</span>
                  )}
                  {label}
                </button>
                {i < STEPS.length - 1 && (
                  <span className="text-muted-foreground">·</span>
                )}
              </li>
            );
          })}
        </ol>

        <div className="rounded-xl border border-border bg-card p-4 sm:p-6">
          <p className="mb-4 text-sm text-muted-foreground">
            {STEPS[stepIndex]![2]}
          </p>

          {step === "name" && (
            <div className="max-w-lg space-y-2">
              <label htmlFor="agent-name" className="text-sm font-medium">
                Agent name
              </label>
              <Input
                id="agent-name"
                autoFocus
                value={name}
                maxLength={80}
                placeholder="Research assistant"
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") next();
                }}
              />
              <p className="text-xs text-muted-foreground">
                Agents are user-named and never renamed automatically.
              </p>
              <label
                htmlFor="agent-description"
                className="pt-2 text-sm font-medium"
              >
                Description
              </label>
              <Textarea
                id="agent-description"
                value={description}
                maxLength={500}
                rows={3}
                placeholder="What this agent does and when to spawn it."
                onChange={(e) => setDescription(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Other agents read this to decide whom to spawn. Optional, 500
                characters max.
              </p>
            </div>
          )}

          {step === "model" && (
            <div className="space-y-2">
              <p className="text-sm font-medium">Model</p>
              {models === null && <Skeleton className="h-10 w-full max-w-lg" />}
              {models !== null && models.length === 0 && (
                <ErrorState
                  title="No models configured"
                  message="Ask an admin to add a model route before creating an agent."
                />
              )}
              {models !== null && models.length > 0 && (
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {models.map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      onClick={() => setModel(option.id)}
                      className={`flex items-center gap-2 rounded-lg border px-3 py-2.5 text-left text-sm outline-none transition-colors ${
                        model === option.id
                          ? "border-foreground bg-accent"
                          : "border-border hover:bg-accent/50"
                      }`}
                    >
                      <span
                        className={`flex size-4 shrink-0 items-center justify-center rounded-full border ${
                          model === option.id
                            ? "border-foreground bg-foreground"
                            : "border-border"
                        }`}
                      >
                        {model === option.id && (
                          <Check className="size-3 text-background" />
                        )}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">
                          {modelLabel(option)}
                        </span>
                        {option.alias !== "" && (
                          <span className="block truncate font-mono text-2xs text-muted-foreground">
                            {option.id}
                          </span>
                        )}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {step === "tools" && (
            <div className="space-y-4">
              <div className="grid gap-1.5">
                <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-border px-3 py-2">
                  <input
                    type="radio"
                    name="create-tools-mode"
                    className="mt-0.5 size-4 accent-foreground"
                    checked={toolsMode === "all"}
                    onChange={() => setToolsMode("all")}
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">
                      All available tools
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      Every built-in tool and every integration an admin makes
                      available.
                    </span>
                  </span>
                </label>
                <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-border px-3 py-2">
                  <input
                    type="radio"
                    name="create-tools-mode"
                    className="mt-0.5 size-4 accent-foreground"
                    checked={toolsMode === "selected"}
                    onChange={() => setToolsMode("selected")}
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">
                      Choose tools
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      Only the tools selected below.
                    </span>
                  </span>
                </label>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-medium">Tools</p>
                <span className="text-xs text-muted-foreground">
                  {toolsMode === "all"
                    ? "All available"
                    : `${tools.length} selected`}
                </span>
                <div className="flex-1" />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setTools(allTools.map((t) => t.name))}
                >
                  Select all tools
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setTools([...SAFE_BASELINE_NAMES])}
                >
                  Safe baseline
                </Button>
              </div>
              {catalogError !== null && <ErrorState message={catalogError} />}
              {groups.map((group) => (
                <div key={group.group} className="space-y-1.5">
                  <p className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                    {group.group}
                  </p>
                  <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                    {group.tools.map((tool) => {
                      const checked = tools.includes(tool.name);
                      return (
                        <label
                          key={tool.name}
                          className={`flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 transition-colors ${
                            checked
                              ? "border-ring bg-accent/60"
                              : "border-border hover:bg-accent/30"
                          }`}
                        >
                          <input
                            type="checkbox"
                            className="mt-0.5 size-4 accent-foreground"
                            checked={checked}
                            onChange={() => toggleTool(tool.name)}
                          />
                          <span className="min-w-0">
                            <span className="block text-sm font-medium">
                              {tool.label || tool.name}
                            </span>
                            <span className="block text-xs text-muted-foreground">
                              {tool.description}
                            </span>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}

          {error !== null && (
            <p role="alert" className="mt-4 text-sm text-destructive">
              {error}
            </p>
          )}

          <div className="mt-6 flex items-center justify-between gap-3">
            <Button
              variant="ghost"
              size="sm"
              onClick={back}
              disabled={submitting}
            >
              <ArrowLeft />
              {stepIndex === 0 ? "Cancel" : "Back"}
            </Button>
            <Button
              size="sm"
              onClick={next}
              disabled={
                submitting ||
                (step === "model" && models !== null && models.length === 0)
              }
            >
              {submitting && <Loader2 className="animate-spin" />}
              {stepIndex === STEPS.length - 1 ? (
                <>
                  <Plus />
                  Create agent
                </>
              ) : (
                <>
                  Next
                  <ArrowRight />
                </>
              )}
            </Button>
          </div>
        </div>
      </PageBody>
    </div>
  );
}
