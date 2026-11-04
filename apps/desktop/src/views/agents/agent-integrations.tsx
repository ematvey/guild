// An agent's Integration list: what its Turns may reach in each Integration,
// up to which class. The member adds only Integrations their audience
// grants them, at most at their own class; an entry outside their audience
// can still be lowered or removed. Warnings show who gains an Integration
// through this agent beyond the Integration's own audience.

import { AlertTriangle, Plus, X } from "lucide-react";
import type { AgentIntegration, AttachableIntegration, IntegrationWarning, ToolClass } from "@guild/wire/rest";
import { Button } from "@guild/ui/components/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@guild/ui/components/select";

export const CLASS_LABEL: Record<ToolClass, string> = {
  read: "Read",
  write: "Read and write",
  admin: "Admin",
};

const CLASS_ORDER: ToolClass[] = ["read", "write", "admin"];
const rank = (cls: ToolClass) => CLASS_ORDER.indexOf(cls);

/** One warning as a sentence: who gains what, and what the audience grants. */
export function warningText(warning: IntegrationWarning, title: string): string {
  const who =
    warning.subject === "org"
      ? "Every member"
      : warning.subject === "team"
        ? `Team ${warning.subject_label}`
        : warning.subject_label;
  const gives = CLASS_LABEL[warning.ceiling].toLowerCase();
  const granted =
    warning.granted === null
      ? `${title} is not available to them`
      : `${title} grants them only ${CLASS_LABEL[warning.granted].toLowerCase()}`;
  return `${who} reaches ${title} (${gives}) through this agent; ${granted}.`;
}

export function IntegrationWarnings({ warnings, title }: { warnings: IntegrationWarning[]; title: string }) {
  if (warnings.length === 0) return null;
  return (
    <ul className="mt-2 space-y-1">
      {warnings.map((warning) => (
        <li
          key={`${warning.subject}:${warning.subject_id ?? ""}`}
          className="flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-500"
        >
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>{warningText(warning, title)}</span>
        </li>
      ))}
    </ul>
  );
}

export function AgentIntegrationsEditor({
  value,
  onChange,
  attachable,
  warnings,
  isAdmin,
}: {
  value: AgentIntegration[];
  onChange: (next: AgentIntegration[]) => void;
  /** null while the first push is pending. */
  attachable: AttachableIntegration[] | null;
  warnings: IntegrationWarning[];
  isAdmin: boolean;
}) {
  const bySlug = new Map((attachable ?? []).map((item) => [item.slug, item]));
  const title = (slug: string) => bySlug.get(slug)?.title ?? slug;
  const available = (attachable ?? []).filter((item) => !value.some((entry) => entry.slug === item.slug));
  const set = (slug: string, ceiling: ToolClass) =>
    onChange(value.map((entry) => (entry.slug === slug ? { ...entry, ceiling } : entry)));

  return (
    <div className="space-y-3">
      {value.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          This agent reaches no integration. Integrations are never added by default; add the ones it needs.
        </p>
      ) : (
        <ul className="space-y-2">
          {value.map((entry) => {
            const mine = bySlug.get(entry.slug);
            // The member may raise up to their own class; an entry outside
            // their audience may only go down.
            const cap: ToolClass = mine?.ceiling ?? entry.ceiling;
            const options = CLASS_ORDER.filter(
              (cls) => rank(cls) <= Math.max(rank(cap), rank(entry.ceiling)) && (cls !== "admin" || isAdmin),
            );
            if (!options.includes(entry.ceiling)) options.push(entry.ceiling);
            return (
              <li key={entry.slug} className="rounded-lg border border-border px-3 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">{title(entry.slug)}</span>
                    {mine === undefined ? (
                      <span className="block text-xs text-muted-foreground">
                        Not available to you: you can lower or remove it, not raise it.
                      </span>
                    ) : !mine.enabled ? (
                      <span className="block text-xs text-muted-foreground">
                        Turned off by an admin; the agent reaches it once it is on.
                      </span>
                    ) : null}
                  </span>
                  <Select value={entry.ceiling} onValueChange={(cls) => set(entry.slug, cls as ToolClass)}>
                    <SelectTrigger className="w-40" aria-label={`Access to ${title(entry.slug)}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {options.map((cls) => (
                        <SelectItem key={cls} value={cls} disabled={rank(cls) > rank(cap) && cls !== entry.ceiling}>
                          {CLASS_LABEL[cls]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove ${title(entry.slug)}`}
                    onClick={() => onChange(value.filter((other) => other.slug !== entry.slug))}
                  >
                    <X />
                  </Button>
                </div>
                <IntegrationWarnings
                  warnings={warnings.filter((warning) => warning.integration === entry.slug)}
                  title={title(entry.slug)}
                />
              </li>
            );
          })}
        </ul>
      )}
      {attachable === null ? null : available.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {attachable.length === 0
            ? "No integration is available to you. An admin decides who may use each one."
            : "Every integration available to you is added."}
        </p>
      ) : (
        <div className="space-y-1.5">
          <p className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">Available to you</p>
          <ul className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
            {available.map((item) => (
              <li key={item.slug} className="flex items-start gap-2 rounded-lg border border-border px-3 py-2">
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{item.title}</span>
                  <span className="block text-xs text-muted-foreground">
                    {item.enabled ? `Up to ${CLASS_LABEL[item.ceiling].toLowerCase()}` : "Turned off by an admin"}
                    {item.summary ? ` · ${item.summary}` : ""}
                  </span>
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onChange([...value, { slug: item.slug, ceiling: "read" }])}
                >
                  <Plus />
                  Add
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
