// The React side of the Generated UI library: one renderer per component
// of @guild/genui, drawn with the app's own kit and theme tokens. Children
// arrive as parsed element nodes and render through `renderNode`.

import { useContext, useEffect, useMemo, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowDownRight, ArrowRight, ArrowUpRight, Check } from "lucide-react";
import {
  FormNameContext,
  FormValidationContext,
  parseStructuredRules,
  useCreateFormValidation,
  useFormName,
  useFormValidation,
  useIsStreaming,
  useStateField,
  useTriggerAction,
  type ComponentRenderer,
} from "@openuidev/react-lang";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Area,
  AreaChart,
  Pie,
  PieChart,
  XAxis,
  YAxis,
} from "recharts";
import { genuiLibrary, type GenuiComponentName, type GenuiProps } from "@guild/genui";
import { Button } from "@guild/ui/components/button";
import { Input } from "@guild/ui/components/input";
import { Textarea } from "@guild/ui/components/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@guild/ui/components/select";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@guild/ui/components/chart";
import { MD_CLASS, mdComponents } from "../markdown";
import { GenuiAnswerContext, GenuiInertContext, answeredBy } from "./actions";

type R<N extends GenuiComponentName> = ComponentRenderer<GenuiProps<N>>;
type Tone = "neutral" | "info" | "success" | "warning" | "danger";

const TONE: Record<Tone, string> = {
  neutral: "border-border bg-muted/50 text-foreground",
  info: "border-sky-500/40 bg-sky-500/10 text-sky-800 dark:text-sky-200",
  success: "border-emerald-500/40 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200",
  warning: "border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-200",
  danger: "border-destructive/40 bg-destructive/10 text-destructive",
};

const SERIES_COLORS = ["--chart-1", "--chart-2", "--chart-3", "--chart-4", "--chart-5", "--chart-6"];
const seriesColor = (i: number) => `var(${SERIES_COLORS[i % SERIES_COLORS.length]})`;

const Stack: R<"Stack"> = ({ props, renderNode }) => (
  <div className={props.direction === "row" ? "flex flex-wrap items-start gap-3" : "flex flex-col gap-3"}>
    {renderNode(props.children)}
  </div>
);

const Card: R<"Card"> = ({ props, renderNode }) => (
  <section className="flex min-w-0 flex-1 flex-col gap-3 rounded-xl border border-border bg-card p-4 text-card-foreground">
    {(props.title || props.description) && (
      <header className="space-y-0.5">
        {props.title && <h3 className="text-sm font-semibold text-foreground">{props.title}</h3>}
        {props.description && <p className="text-xs text-muted-foreground">{props.description}</p>}
      </header>
    )}
    {renderNode(props.children)}
  </section>
);

const Grid: R<"Grid"> = ({ props, renderNode }) => {
  const columns = Math.min(Math.max(Math.round(props.columns ?? 3), 1), 6);
  return (
    <div
      className="grid grid-cols-1 gap-3 sm:grid-cols-[repeat(var(--genui-cols),minmax(0,1fr))]"
      style={{ ["--genui-cols" as string]: columns }}
    >
      {renderNode(props.children)}
    </div>
  );
};

const Tabs: R<"Tabs"> = ({ props, renderNode }) => {
  const [active, setActive] = useState(0);
  const items = props.items as unknown as { props: { label: string; children: unknown } }[];
  const current = Math.min(active, Math.max(items.length - 1, 0));
  return (
    <div className="flex flex-col gap-3">
      <div role="tablist" className="flex flex-wrap gap-1 border-b border-border">
        {items.map((tab, i) => (
          <button
            key={i}
            type="button"
            role="tab"
            aria-selected={i === current}
            onClick={() => setActive(i)}
            className={`-mb-px border-b-2 px-3 py-1.5 text-sm transition-colors ${
              i === current
                ? "border-foreground font-medium text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {tab.props?.label}
          </button>
        ))}
      </div>
      {items[current] && <div className="flex flex-col gap-3">{renderNode(items[current].props.children)}</div>}
    </div>
  );
};

// Tab renders through Tabs; standing alone it shows its content.
const Tab: R<"Tab"> = ({ props, renderNode }) => (
  <div className="flex flex-col gap-3">{renderNode(props.children)}</div>
);

const Separator: R<"Separator"> = () => <hr className="border-border" />;

const TEXT_CLASS = {
  body: "text-base",
  muted: "text-sm text-muted-foreground",
  title: "text-lg font-semibold text-foreground",
  subtitle: "text-sm font-medium text-foreground",
} as const;

const Text: R<"Text"> = ({ props }) => (
  <div className={`${MD_CLASS} ${TEXT_CLASS[props.variant ?? "body"]} [&_p]:m-0`}>
    <Markdown remarkPlugins={[remarkGfm]} components={mdComponents}>
      {props.text}
    </Markdown>
  </div>
);

const TREND_ICON = { up: ArrowUpRight, down: ArrowDownRight, flat: ArrowRight } as const;

const Metric: R<"Metric"> = ({ props }) => {
  const Icon = props.trend ? TREND_ICON[props.trend] : null;
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1 rounded-xl border border-border bg-card px-4 py-3">
      <span className="truncate text-xs text-muted-foreground">{props.label}</span>
      <span className="truncate text-xl font-semibold tabular-nums text-foreground">{String(props.value)}</span>
      {(props.delta || Icon) && (
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          {Icon && <Icon className="size-3.5 shrink-0" aria-hidden />}
          {props.delta}
        </span>
      )}
    </div>
  );
};

const Callout: R<"Callout"> = ({ props }) => (
  <div className={`rounded-lg border px-3 py-2 ${TONE[props.tone ?? "info"]}`}>
    {props.title && <p className="text-sm font-semibold">{props.title}</p>}
    <div className={`${MD_CLASS} text-sm [&_p]:m-0`}>
      <Markdown remarkPlugins={[remarkGfm]} components={mdComponents}>
        {props.text}
      </Markdown>
    </div>
  </div>
);

const List: R<"List"> = ({ props }) => {
  const items = props.items.map((item, i) => <li key={i}>{item}</li>);
  return props.ordered ? (
    <ol className="list-decimal space-y-1 pl-6 text-base">{items}</ol>
  ) : (
    <ul className="list-disc space-y-1 pl-6 text-base">{items}</ul>
  );
};

const Progress: R<"Progress"> = ({ props }) => {
  const max = props.max && props.max > 0 ? props.max : 100;
  const pct = Math.min(Math.max((props.value / max) * 100, 0), 100);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex justify-between gap-2 text-xs text-muted-foreground">
        <span className="truncate">{props.label}</span>
        <span className="tabular-nums">{max === 100 ? `${Math.round(pct)}%` : `${props.value} / ${max}`}</span>
      </div>
      <div
        className="h-2 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-valuenow={props.value}
        aria-valuemax={max}
      >
        <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
};

const Fact: R<"Fact"> = ({ props }) => (
  <div className="flex justify-between gap-4 border-b border-border py-1.5 last:border-b-0">
    <dt className="text-sm text-muted-foreground">{props.label}</dt>
    <dd className="text-right text-sm text-foreground">{String(props.value)}</dd>
  </div>
);

const Facts: R<"Facts"> = ({ props, renderNode }) => <dl className="flex flex-col">{renderNode(props.items)}</dl>;

const Tag: R<"Tag"> = ({ props }) => (
  <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs ${TONE[props.tone ?? "neutral"]}`}>
    {props.text}
  </span>
);

const Tags: R<"Tags"> = ({ props, renderNode }) => (
  <div className="flex flex-wrap gap-1.5">{renderNode(props.items)}</div>
);

const Table: R<"Table"> = ({ props }) => (
  <div className="max-w-full overflow-x-auto rounded-lg border border-border">
    <table className="w-full text-xs [overflow-wrap:break-word]">
      {props.caption && <caption className="px-3 py-1.5 text-left text-muted-foreground">{props.caption}</caption>}
      <thead>
        <tr>
          {props.columns.map((c, i) => (
            <th key={i} className="border-b-2 border-border px-3 py-1.5 text-left font-semibold">
              {c}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {props.rows.map((row, r) => (
          <tr key={r} className="even:bg-muted/40">
            {props.columns.map((_, c) => {
              const v = row[c];
              return (
                <td
                  key={c}
                  className={`border-t border-border px-3 py-1.5 align-top ${typeof v === "number" ? "text-right tabular-nums" : ""}`}
                >
                  {v === null || v === undefined ? "" : typeof v === "boolean" ? (v ? "yes" : "no") : String(v)}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

// Charts: series become columns s0, s1, … of one row per label, so a
// series name never has to be a valid CSS identifier.
interface SeriesNode {
  props: { name: string; values: number[] };
}

function seriesData(
  labels: string[],
  series: unknown,
): { rows: Record<string, unknown>[]; config: ChartConfig; keys: string[] } {
  const list = (Array.isArray(series) ? series : []) as SeriesNode[];
  const keys = list.map((_, i) => `s${i}`);
  const config: ChartConfig = {};
  list.forEach((s, i) => {
    config[`s${i}`] = { label: s.props?.name ?? `Series ${i + 1}`, color: seriesColor(i) };
  });
  const rows = labels.map((label, i) => {
    const row: Record<string, unknown> = { label };
    list.forEach((s, j) => {
      row[`s${j}`] = s.props?.values?.[i] ?? 0;
    });
    return row;
  });
  return { rows, config, keys };
}

const CHART_CLASS = "aspect-auto h-56 w-full";

const BarChartView: R<"BarChart"> = ({ props }) => {
  const { rows, config, keys } = useMemo(() => seriesData(props.labels, props.series), [props.labels, props.series]);
  return (
    <ChartContainer config={config} className={CHART_CLASS}>
      <BarChart data={rows} margin={{ left: 0, right: 8, top: 8 }}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="label" tickLine={false} axisLine={false} />
        <YAxis tickLine={false} axisLine={false} width={40} />
        <ChartTooltip content={<ChartTooltipContent />} />
        {keys.length > 1 && <ChartLegend content={<ChartLegendContent />} />}
        {keys.map((k) => (
          <Bar key={k} dataKey={k} fill={`var(--color-${k})`} radius={3} stackId={props.stacked ? "a" : undefined} />
        ))}
      </BarChart>
    </ChartContainer>
  );
};

const LineChartView: R<"LineChart"> = ({ props }) => {
  const { rows, config, keys } = useMemo(() => seriesData(props.labels, props.series), [props.labels, props.series]);
  const common = (
    <>
      <CartesianGrid vertical={false} />
      <XAxis dataKey="label" tickLine={false} axisLine={false} />
      <YAxis tickLine={false} axisLine={false} width={40} />
      <ChartTooltip content={<ChartTooltipContent />} />
      {keys.length > 1 && <ChartLegend content={<ChartLegendContent />} />}
    </>
  );
  return (
    <ChartContainer config={config} className={CHART_CLASS}>
      {props.area ? (
        <AreaChart data={rows} margin={{ left: 0, right: 8, top: 8 }}>
          {common}
          {keys.map((k) => (
            <Area
              key={k}
              dataKey={k}
              type="monotone"
              stroke={`var(--color-${k})`}
              fill={`var(--color-${k})`}
              fillOpacity={0.2}
            />
          ))}
        </AreaChart>
      ) : (
        <LineChart data={rows} margin={{ left: 0, right: 8, top: 8 }}>
          {common}
          {keys.map((k) => (
            <Line key={k} dataKey={k} type="monotone" stroke={`var(--color-${k})`} strokeWidth={2} dot={false} />
          ))}
        </LineChart>
      )}
    </ChartContainer>
  );
};

const PieChartView: R<"PieChart"> = ({ props }) => {
  const { rows, config } = useMemo(() => {
    const config: ChartConfig = {};
    const rows = props.labels.map((label, i) => {
      config[`p${i}`] = { label, color: seriesColor(i) };
      return { key: `p${i}`, value: props.values[i] ?? 0 };
    });
    return { rows, config };
  }, [props.labels, props.values]);
  return (
    <ChartContainer config={config} className={CHART_CLASS}>
      <PieChart>
        <ChartTooltip content={<ChartTooltipContent nameKey="key" hideLabel />} />
        <Pie data={rows} dataKey="value" nameKey="key" innerRadius="45%" strokeWidth={2}>
          {rows.map((r) => (
            <Cell key={r.key} fill={`var(--color-${r.key})`} />
          ))}
        </Pie>
        <ChartLegend content={<ChartLegendContent nameKey="key" />} />
      </PieChart>
    </ChartContainer>
  );
};

// Interaction. Buttons fire the renderer's action; inside a Form the
// primary button validates the fields first.
const VARIANT = { primary: "default", secondary: "outline", destructive: "destructive" } as const;

/** The message a button sends to the agent, or null when it sends none
 *  (an @OpenUrl button). A button without an action sends its label. */
function sentMessage(label: string, action: unknown): string | null {
  if (action === undefined || action === null) return label;
  const steps = (action as { steps?: { type?: string; message?: unknown }[] }).steps;
  if (Array.isArray(steps)) {
    const step = steps.find((s) => s.type === "continue_conversation");
    return step && typeof step.message === "string" ? step.message : null;
  }
  const type = (action as { type?: string }).type;
  return type === undefined || type === "continue_conversation" ? label : null;
}

/** Inert controls: the block is streaming, already answered, or shown
 *  where nothing can be sent. */
function useInert(): boolean {
  const settled = useContext(GenuiInertContext);
  const streaming = useIsStreaming();
  return settled || streaming;
}

const GenButton: R<"Button"> = ({ props }) => {
  const triggerAction = useTriggerAction();
  const formName = useFormName();
  const inert = useInert();
  const streaming = useIsStreaming();
  const answer = useContext(GenuiAnswerContext);
  const validation = useFormValidation();
  const variant = props.variant ?? "primary";
  const message = sentMessage(props.label, props.action);
  const chosen = message !== null && answeredBy(answer, message);
  // An @OpenUrl-only button sends nothing, so it stays usable after the
  // block is answered.
  const disabled = message === null ? streaming : inert;
  return (
    <Button
      type="button"
      size="sm"
      variant={VARIANT[variant]}
      disabled={disabled}
      aria-pressed={chosen || undefined}
      className={chosen ? "ring-2 ring-ring ring-offset-1 ring-offset-background disabled:opacity-100" : undefined}
      onClick={() => {
        if (validation && variant === "primary" && !validation.validateForm()) return;
        void triggerAction(props.label, formName, props.action as Parameters<typeof triggerAction>[2]);
      }}
    >
      {chosen && <Check className="size-4" aria-hidden />}
      {props.label}
    </Button>
  );
};

const Buttons: R<"Buttons"> = ({ props, renderNode }) => (
  <div className="flex flex-wrap gap-2">{renderNode(props.items)}</div>
);

const Form: R<"Form"> = ({ props, renderNode }) => {
  const validation = useCreateFormValidation();
  return (
    <FormValidationContext.Provider value={validation}>
      <FormNameContext.Provider value={props.name}>
        <div role="form" className="flex flex-col gap-3">
          {renderNode(props.fields)}
          {renderNode(props.buttons)}
        </div>
      </FormNameContext.Provider>
    </FormValidationContext.Provider>
  );
};

interface InputNode {
  type?: string;
  typeName?: string;
  props?: { name?: string; rules?: { required?: boolean } };
}

const Field: R<"Field"> = ({ props, renderNode }) => {
  const validation = useFormValidation();
  const input = props.input as unknown as InputNode;
  const name = input?.props?.name;
  const error = name ? validation?.errors[name] : undefined;
  const isCheckbox = input?.typeName === "Checkbox";
  return (
    <div className="flex flex-col gap-1.5">
      {!isCheckbox && (
        <label htmlFor={name} className="text-sm font-medium text-foreground">
          {props.label}
          {input?.props?.rules?.required && <span className="text-destructive"> *</span>}
        </label>
      )}
      {renderNode(props.input)}
      {error ? (
        <span className="text-xs text-destructive">{error}</span>
      ) : props.hint ? (
        <span className="text-xs text-muted-foreground">{props.hint}</span>
      ) : null}
    </div>
  );
};

/** Registers a field's rules with its form once the block settles, and
 *  returns the blur check. */
function useFieldRules(name: string, rules: unknown, value: unknown) {
  const streaming = useIsStreaming();
  const inert = useInert();
  const validation = useFormValidation();
  const parsed = useMemo(() => parseStructuredRules(rules), [rules]);
  useEffect(() => {
    if (streaming || parsed.length === 0 || !validation) return;
    validation.registerField(name, parsed, () => value);
    return () => validation.unregisterField(name);
  }, [name, parsed, streaming, validation, value]);
  return {
    inert,
    onFocus: () => validation?.clearFieldError(name),
    onBlur: (v: unknown) => {
      if (parsed.length > 0) validation?.validateField(name, v, parsed);
    },
  };
}

const GenInput: R<"Input"> = ({ props }) => {
  const field = useStateField<string>(props.name, props.value);
  const rules = useFieldRules(field.name, props.rules, field.value);
  return (
    <Input
      id={field.name}
      name={field.name}
      type={props.type ?? "text"}
      placeholder={props.placeholder ?? ""}
      value={(field.value as string | undefined) ?? ""}
      disabled={rules.inert}
      onFocus={rules.onFocus}
      onChange={(e) => field.setValue(e.target.value)}
      onBlur={(e) => rules.onBlur(e.target.value)}
    />
  );
};

const GenTextArea: R<"TextArea"> = ({ props }) => {
  const field = useStateField<string>(props.name, props.value);
  const rules = useFieldRules(field.name, props.rules, field.value);
  return (
    <Textarea
      id={field.name}
      name={field.name}
      rows={3}
      placeholder={props.placeholder ?? ""}
      value={(field.value as string | undefined) ?? ""}
      disabled={rules.inert}
      onFocus={rules.onFocus}
      onChange={(e) => field.setValue(e.target.value)}
      onBlur={(e) => rules.onBlur(e.target.value)}
    />
  );
};

const GenSelect: R<"Select"> = ({ props }) => {
  const field = useStateField<string>(props.name, props.value);
  const rules = useFieldRules(field.name, props.rules, field.value);
  const value = (field.value as string | undefined) ?? "";
  return (
    <Select
      value={value === "" ? undefined : value}
      disabled={rules.inert}
      onValueChange={(v) => {
        field.setValue(v);
        rules.onFocus();
      }}
    >
      <SelectTrigger id={field.name}>
        <SelectValue placeholder={props.placeholder ?? "Choose…"} />
      </SelectTrigger>
      <SelectContent>
        {props.options
          .filter((o) => o !== "")
          .map((o) => (
            <SelectItem key={o} value={o}>
              {o}
            </SelectItem>
          ))}
      </SelectContent>
    </Select>
  );
};

const GenCheckbox: R<"Checkbox"> = ({ props }) => {
  const field = useStateField<boolean>(props.name, props.value);
  const inert = useInert();
  return (
    <label className="flex cursor-pointer items-center gap-2 text-sm">
      <input
        type="checkbox"
        className="size-4 accent-foreground"
        name={field.name}
        checked={field.value === true}
        disabled={inert}
        onChange={(e) => field.setValue(e.target.checked)}
      />
      <span>{props.label}</span>
    </label>
  );
};

// Series is data for its chart; on its own it renders nothing.
const Series: R<"Series"> = () => null;

/** A renderer of any component: the library holds them side by side. */
type AnyRenderer = ComponentRenderer<any>;

/** The Generated UI library the transcript renders `openui` blocks with. */
export const genuiReactLibrary = genuiLibrary<AnyRenderer>({
  Stack,
  Card,
  Grid,
  Tabs,
  Tab,
  Separator,
  Text,
  Metric,
  Callout,
  List,
  Progress,
  Facts,
  Fact,
  Tags,
  Tag,
  Table,
  Series,
  BarChart: BarChartView,
  LineChart: LineChartView,
  PieChart: PieChartView,
  Buttons,
  Button: GenButton,
  Form,
  Field,
  Input: GenInput,
  TextArea: GenTextArea,
  Select: GenSelect,
  Checkbox: GenCheckbox,
} as Record<GenuiComponentName, AnyRenderer>);
