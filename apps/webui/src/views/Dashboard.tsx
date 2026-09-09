import { useEffect, useState } from "react";
import { api } from "../api";
import { Card, CardContent, CardHeader, CardTitle } from "@guild/ui/components/card";

interface UsageRow {
  group: string;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  requests: number;
}

export default function Dashboard() {
  const [summary, setSummary] = useState<{ today_cost_usd: number; month_cost_usd: number } | null>(null);
  const [rows, setRows] = useState<UsageRow[]>([]);
  const [groupBy, setGroupBy] = useState("model");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ today_cost_usd: number; month_cost_usd: number }>("GET", "/api/v1/usage/summary")
      .then(setSummary)
      .catch((e) => setError(String(e.message ?? e)));
  }, []);

  useEffect(() => {
    api<{ rows: UsageRow[] }>("GET", `/api/v1/usage?group_by=${groupBy}`)
      .then((r) => setRows(r.rows))
      .catch((e) => setError(String(e.message ?? e)));
  }, [groupBy]);

  return (
    <div className="space-y-6 p-6">
      {error && <p className="text-sm text-red-400">{error}</p>}
      <div className="flex gap-4">
        <Card className="flex-1">
          <CardHeader>
            <CardTitle className="text-sm text-muted-foreground">Today</CardTitle>
          </CardHeader>
          <CardContent>
            <span className="text-2xl font-semibold">${summary?.today_cost_usd?.toFixed(4) ?? "…"}</span>
          </CardContent>
        </Card>
        <Card className="flex-1">
          <CardHeader>
            <CardTitle className="text-sm text-muted-foreground">This month</CardTitle>
          </CardHeader>
          <CardContent>
            <span className="text-2xl font-semibold">${summary?.month_cost_usd?.toFixed(4) ?? "…"}</span>
          </CardContent>
        </Card>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">group by</span>
        {["user", "team", "model"].map((g) => (
          <button
            key={g}
            className={`rounded px-2 py-1 text-xs ${groupBy === g ? "bg-primary text-primary-foreground" : "bg-card text-muted-foreground hover:text-foreground"}`}
            onClick={() => setGroupBy(g)}
          >
            {g}
          </button>
        ))}
      </div>
      <table className="w-full text-sm">
        <thead className="text-left text-muted-foreground">
          <tr>
            <th className="py-2">{groupBy}</th>
            <th>tokens in</th>
            <th>tokens out</th>
            <th>requests</th>
            <th className="text-right">cost</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.group} className="border-t border-border">
              <td className="py-2 font-mono text-xs">{r.group}</td>
              <td>{r.tokens_in}</td>
              <td>{r.tokens_out}</td>
              <td>{r.requests}</td>
              <td className="text-right">${r.cost_usd.toFixed(4)}</td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={5} className="py-4 text-muted-foreground">
                no usage yet
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
