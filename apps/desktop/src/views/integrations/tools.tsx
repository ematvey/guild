// The Tools tab: every tool the integration declares (or an MCP server
// serves), each with its switch and approval rule. Built-in and plugin
// tools come from their declarations; an MCP server is asked live, and a
// tool it starts serving later arrives switched off.

import { useState } from "react";
import { toast } from "sonner";
import { RefreshCw } from "lucide-react";
import { Button } from "@guild/ui/components/button";
import { SkeletonRows } from "@guild/ui/components/skeleton";
import { useCachedGet } from "../settings/use-cached-api";
import { integrationToolsPath, putIntegrationTool } from "../../lib/api/settings";

interface CuratedTool {
  name: string;
  tool: string;
  class: string;
  description: string;
  /** Unset means on: a tool no admin has turned off is enabled. */
  enabled?: boolean;
  approval: "default" | "always_ask" | "always_allow";
}

/** Whether a tool is on: only an explicit `false` turns it off. */
export function toolOn(tool: Pick<CuratedTool, "enabled">): boolean {
  return tool.enabled !== false;
}

interface ToolsResponse {
  resolved: boolean;
  kind?: string;
  reason?: string;
  tools: CuratedTool[];
}

const CLASS_HINT: Record<string, string> = {
  read: "Reads data. Members and admins can call it.",
  write: "Changes data. Admins, and members when their policy allows.",
  admin: "Administrative. Admins only.",
};

const SELECT = "h-8 rounded-md border border-border bg-background px-2 text-sm disabled:opacity-50";

export function ToolsTab({ id, isMcp }: { id: string; isMcp: boolean }) {
  const res = useCachedGet<ToolsResponse>(integrationToolsPath(id));
  const data = res.data ?? null;
  const [busyTool, setBusyTool] = useState<string | null>(null);

  const update = async (tool: CuratedTool, patch: Partial<CuratedTool>) => {
    setBusyTool(tool.name);
    try {
      await putIntegrationTool(id, tool.name, {
        enabled: patch.enabled ?? toolOn(tool),
        approval: patch.approval ?? tool.approval,
        ...(patch.class !== undefined ? { class: patch.class } : {}),
      });
      res.reload();
    } catch (e) {
      toast.error("Could not update the tool", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusyTool(null);
    }
  };

  const enabledCount = data?.tools.filter(toolOn).length ?? 0;

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Tools</h2>
          <p className="mt-1 max-w-prose text-sm text-muted-foreground">
            {isMcp
              ? "Asked live from the MCP server. A tool it starts serving later arrives switched off."
              : "What agents can call. Turn a tool off to hide it from every chat; the approval rule decides when a person is asked first."}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {data?.resolved && (
            <span className="text-xs text-muted-foreground">
              {enabledCount} of {data.tools.length} on
            </span>
          )}
          <Button variant="outline" size="sm" onClick={() => res.reload()}>
            <RefreshCw className="size-3.5" /> Refresh
          </Button>
        </div>
      </div>

      {res.error ? (
        <p role="alert" className="mt-6 text-sm text-destructive">
          {res.error}
        </p>
      ) : data === null ? (
        <div className="mt-6 space-y-3">
          <SkeletonRows rows={4} />
        </div>
      ) : !data.resolved ? (
        <p className="mt-6 text-sm text-muted-foreground">
          {data.reason ?? "Turn the integration on and save its configuration to list its tools."}
        </p>
      ) : data.tools.length === 0 ? (
        <p className="mt-6 text-sm text-muted-foreground">The server offers no tools.</p>
      ) : (
        <div className="mt-6 overflow-x-auto">
          <table className="w-full min-w-[40rem] border-collapse text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="w-12 py-2 pr-3 font-medium">On</th>
                <th className="py-2 pr-6 font-medium">Tool</th>
                <th className="w-28 py-2 pr-4 font-medium">Class</th>
                <th className="w-48 py-2 font-medium">Approval</th>
              </tr>
            </thead>
            <tbody>
              {data.tools.map((t) => {
                const busy = busyTool === t.name;
                return (
                  <tr
                    key={t.name}
                    className={`border-b border-border/70 align-top ${toolOn(t) ? "" : "text-muted-foreground"}`}
                  >
                    <td className="py-3 pr-3">
                      <input
                        type="checkbox"
                        aria-label={`Turn ${t.name} on`}
                        className="mt-0.5 size-4 accent-foreground"
                        disabled={busy}
                        checked={toolOn(t)}
                        onChange={(e) => update(t, { enabled: e.target.checked })}
                      />
                    </td>
                    <td className="py-3 pr-6">
                      <p className="font-mono text-xs text-foreground">{t.name}</p>
                      {t.description && (
                        <p className="mt-1 max-w-prose text-xs text-muted-foreground">{t.description}</p>
                      )}
                    </td>
                    <td className="py-2.5 pr-4">
                      {isMcp ? (
                        <select
                          aria-label={`Class of ${t.name}`}
                          title={CLASS_HINT[t.class]}
                          className={SELECT}
                          disabled={busy}
                          value={t.class}
                          onChange={(e) => update(t, { class: e.target.value })}
                        >
                          <option value="read">Read</option>
                          <option value="write">Write</option>
                          <option value="admin">Admin</option>
                        </select>
                      ) : (
                        <span title={CLASS_HINT[t.class]} className="text-xs capitalize">
                          {t.class}
                        </span>
                      )}
                    </td>
                    <td className="py-2.5">
                      <select
                        aria-label={`Approval for ${t.name}`}
                        className={`${SELECT} w-full`}
                        disabled={busy}
                        value={t.approval}
                        onChange={(e) => update(t, { approval: e.target.value as CuratedTool["approval"] })}
                      >
                        <option value="default">Follow member policy</option>
                        <option value="always_ask">Always ask</option>
                        <option value="always_allow">Always allow</option>
                      </select>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
