//! ChatSpendChip — per-chat spend in the thread header: a tiny daily-cost
//! sparkline plus the all-time total. Lazy-imported (recharts must not land
//! in the main chat bundle); refetches when a generation finishes so the
//! number tracks live usage.

import { useEffect, useState } from "react";
import { Area, AreaChart } from "recharts";
import { ChartContainer, type ChartConfig } from "@guild/ui/components/chart";
import { getChatUsage, type UsagePoint } from "../transport";

const config = {
  cost: { label: "Spend", color: "var(--primary)" },
} satisfies ChartConfig;

export function ChatSpendChip({ chatId, busy }: { chatId: string; busy: boolean }) {
  const [points, setPoints] = useState<UsagePoint[] | null>(null);
  const [total, setTotal] = useState(0);

  useEffect(() => {
    let dead = false;
    getChatUsage(chatId)
      .then((u) => {
        if (!dead) {
          setPoints(u.points);
          setTotal(u.total);
        }
      })
      .catch(() => {
        if (!dead) setPoints([]);
      });
    return () => {
      dead = true;
    };
  }, [chatId, busy]);

  const data = (points ?? []).map((p) => ({ bucket: p.bucket, cost: p.cost_usd }));

  return (
    <span
      className="flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
      title="Spend in this chat"
    >
      {points !== null && data.some((d) => d.cost > 0) && (
        <ChartContainer config={config} className="aspect-auto h-4 w-14">
          <AreaChart data={data} margin={{ top: 2, bottom: 2, left: 0, right: 0 }}>
            <Area
              dataKey="cost"
              type="monotone"
              stroke="var(--color-cost)"
              fill="var(--color-cost)"
              fillOpacity={0.25}
              strokeWidth={1}
            />
          </AreaChart>
        </ChartContainer>
      )}
      <span className="tabular-nums">${total.toFixed(4)}</span>
    </span>
  );
}
