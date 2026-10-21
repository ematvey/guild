import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Loader2,
  Lock,
  Plus,
  Users,
} from "lucide-react";
import { Button } from "@guild/ui/components/button";
import { Input } from "@guild/ui/components/input";
import { Textarea } from "@guild/ui/components/textarea";
import { Skeleton } from "@guild/ui/components/skeleton";
import { listModels, modelLabel, type ModelOption } from "../../transport";
import {
  SAFE_BASELINE_NAMES,
  SAFE_BASELINE_TOOLS,
  createAgent,
  groupTools,
  listAgentTools,
  listMyTeams,
  type Agent,
  type AgentToolInfo,
  type TeamOption,
} from "./agents-api";
import type { AgentVisibility, AgentsRoute } from "./agents-route";
import { ErrorState, PageBody, PageHeader } from "./agent-ui";

type Step = "name" | "instructions" | "model" | "tools" | "visibility";

const STEPS: ReadonlyArray<readonly [Step, string, string]> = [
  ["name", "Name", "Give the agent a short, unique name."],
  ["instructions", "Instructions", "Tell the agent how to work and what to care about."],
  ["model", "Model", "Pick one model from the organization catalog."],
  ["tools", "Tools", "Choose the tools this agent may use."],
  ["visibility", "Visibility", "Choose who can see and use the agent."],
];

const VISIBILITY_OPTIONS: ReadonlyArray<
  readonly [AgentVisibility, string, string, typeof Lock]
> = [
  ["private", "Private", "Only you can see and use this agent.", Lock],
  ["team", "Team", "Your teams can use this agent.", Users],
  ["org", "Organization", "Every member can use this agent.", Users],
];

export function validateAgentStep(
  step: Step,
  value: {
    name: string;
    instructions: string;
    model: string;
    tools: string[];
    toolsMode: "selected" | "all";
    visibility: AgentVisibility;
    teamIds: string[];
  },
): string | null {
  switch (step) {
    case "name":
      if (value.name.trim() === "") return "Enter a name.";
      if (value.name.trim().length > 80) return "Use 80 characters or fewer.";
      return null;
    case "instructions":
      return value.instructions.trim() === "" ? "Enter instructions." : null;
    case "model":
      return value.model === "" ? "Pick a model." : null;
    case "tools":
      return value.toolsMode === "selected" && value.tools.length === 0
        ? "Select at least one tool."
        : null;
    case "visibility":
      if (value.visibility === "team" && value.teamIds.length === 0) {
        return "Select at least one team.";
      }
      return null;
  }
}

export function AgentCreate({
  onNavigate,
  onCreated,
}: {
  onNavigate: (route: AgentsRoute) => void;
  onCreated?: (agent: Agent) => void;
}) {
  const [step, setStep] = useState<Step>("name");
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [model, setModel] = useState("");
  const [tools, setTools] = useState<string[]>(SAFE_BASELINE_NAMES);
  const [toolsMode, setToolsMode] = useState<"selected" | "all">("selected");
  const [visibility, setVisibility] = useState<AgentVisibility>("private");
  const [teamIds, setTeamIds] = useState<string[]>([]);
  const [teams, setTeams] = useState<TeamOption[]>([]);
  const [models, setModels] = useState<ModelOption[] | null>(null);
  const [catalog, setCatalog] = useState<AgentToolInfo[] | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    void listModels().then((rows) => {
      setModels(rows ?? []);
      if (rows && rows.length > 0) setModel((current) => current || rows[0]!.id);
    });
    void listAgentTools()
      .then((rows) => setCatalog(rows.length > 0 ? rows : SAFE_BASELINE_TOOLS))
      .catch(() => setCatalog(SAFE_BASELINE_TOOLS));
    void listMyTeams()
      .then(setTeams)
      .catch(() => setTeams([]));
  }, []);

  const groups = useMemo(() => groupTools(catalog ?? SAFE_BASELINE_TOOLS), [catalog]);
  const stepIndex = STEPS.findIndex(([id]) => id === step);
  const currentError = validateAgentStep(step, {
    name,
    instructions,
    model,
    tools,
    toolsMode,
    visibility,
    teamIds,
  });

  const go = (next: Step) => {
    setError(null);
    setStep(next);
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
      const agent = await createAgent({
        name: name.trim(),
        instructions: instructions.trim(),
        model,
        tools,
        tools_mode: toolsMode,
        visibility,
        ...(visibility === "team" ? { team_ids: teamIds } : {}),
      });
      onCreated?.(agent);
      onNavigate({ view: "agent", agentId: agent.id, tab: "overview" });
    } catch (err) {
      setCatalogError(null);
      setError(err instanceof Error ? err.message : "Could not create the agent.");
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
        title="Create agent"
        description={`Step ${stepIndex + 1} of ${STEPS.length} · ${STEPS[stepIndex]![1]}`}
        actions={
          <Button variant="ghost" size="sm" onClick={() => onNavigate({ view: "directory" })}>
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
                  {done ? <Check className="size-3" /> : <span className="font-mono">{i + 1}</span>}
                  {label}
                </button>
                {i < STEPS.length - 1 && <span className="text-muted-foreground">·</span>}
              </li>
            );
          })}
        </ol>

        <div className="rounded-xl border border-border bg-card p-4 sm:p-6">
          <p className="mb-4 text-sm text-muted-foreground">{STEPS[stepIndex]![2]}</p>

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
            </div>
          )}

          {step === "instructions" && (
            <div className="space-y-2">
              <label htmlFor="agent-instructions" className="text-sm font-medium">
                Instructions
              </label>
              <Textarea
                id="agent-instructions"
                autoFocus
                value={instructions}
                rows={12}
                placeholder="You keep the weekly research digest. Read from memories/, write short notes, and send one summary each Friday."
                onChange={(e) => setInstructions(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                These instructions are the agent's standing brief. Threads do not replace them.
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
                <div className="grid gap-2 sm:grid-cols-2">
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
                          model === option.id ? "border-foreground bg-foreground" : "border-border"
                        }`}
                      >
                        {model === option.id && <Check className="size-3 text-background" />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{modelLabel(option)}</span>
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
                    <span className="block text-sm font-medium">All available tools</span>
                    <span className="block text-xs text-muted-foreground">
                      Includes every integration the org enables now and later.
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
                    <span className="block text-sm font-medium">Choose tools</span>
                    <span className="block text-xs text-muted-foreground">
                      Only the tools selected below.
                    </span>
                  </span>
                </label>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-medium">Tools</p>
                <span className="text-xs text-muted-foreground">
                  {toolsMode === "all" ? "All available" : `${tools.length} selected`}
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
                  <div className="grid gap-1.5 sm:grid-cols-2">
                    {group.tools.map((tool) => {
                      const checked = tools.includes(tool.name);
                      return (
                        <label
                          key={tool.name}
                          className={`flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 transition-colors ${
                            checked ? "border-ring bg-accent/60" : "border-border hover:bg-accent/30"
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

          {step === "visibility" && (
            <div className="space-y-4">
            <div className="grid gap-2 sm:grid-cols-3">
              {VISIBILITY_OPTIONS.map(([id, label, body, Icon]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setVisibility(id)}
                  className={`flex flex-col gap-2 rounded-lg border p-3 text-left outline-none transition-colors ${
                    visibility === id
                      ? "border-foreground bg-accent"
                      : "border-border hover:bg-accent/50"
                  }`}
                >
                  <Icon className="size-4 text-muted-foreground" />
                  <span className="text-sm font-medium">{label}</span>
                  <span className="text-xs text-muted-foreground">{body}</span>
                </button>
              ))}
            </div>
            {visibility === "team" && (
              <div className="space-y-2 rounded-lg border border-border p-3">
                <p className="text-sm font-medium">Teams</p>
                {teams.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    You are not a member of any team yet. An admin can add you under Settings →
                    Teams.
                  </p>
                ) : (
                  <div className="grid gap-2 sm:grid-cols-2">
                    {teams.map((team) => {
                      const checked = teamIds.includes(team.id);
                      return (
                        <label
                          key={team.id}
                          className="flex cursor-pointer items-center gap-2 rounded-md border border-border px-2.5 py-2 text-sm"
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() =>
                              setTeamIds((current) =>
                                checked
                                  ? current.filter((id) => id !== team.id)
                                  : [...current, team.id],
                              )
                            }
                          />
                          <span className="truncate">{team.name}</span>
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
            </div>
          )}

          {error !== null && (
            <p role="alert" className="mt-4 text-sm text-destructive">
              {error}
            </p>
          )}

          <div className="mt-6 flex items-center justify-between gap-3">
            <Button variant="ghost" size="sm" onClick={back} disabled={submitting}>
              <ArrowLeft />
              {stepIndex === 0 ? "Cancel" : "Back"}
            </Button>
            <Button size="sm" onClick={next} disabled={submitting || (step === "model" && models !== null && models.length === 0)}>
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
