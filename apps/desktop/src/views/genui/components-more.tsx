// Generated UI renderers beyond the core set: structure (Accordion, Modal,
// Carousel, Steps), media (Image, ImageGallery, EntityList), code, the
// extra charts, follow-up chips and the richer form inputs.

import { useContext, useMemo } from "react";
import { Check, ChevronRight, Circle, CircleDot, Plus, Trash2, X } from "lucide-react";
import { useIsStreaming, useStateField, useTriggerAction, type ComponentRenderer } from "@openuidev/react-lang";
import {
  PolarAngleAxis,
  PolarGrid,
  Radar,
  RadarChart,
  RadialBar,
  RadialBarChart,
  CartesianGrid,
  Scatter,
  ScatterChart,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts";
import type { GenuiComponentName, GenuiProps } from "@guild/genui";
import { Button } from "@guild/ui/components/button";
import { Input } from "@guild/ui/components/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@guild/ui/components/dialog";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@guild/ui/components/chart";
import { highlightJs } from "../js-highlight";
import { GenuiAnswerContext, GenuiInertContext, answeredBy } from "./actions";
import { ContentImage } from "./image";

type R<N extends GenuiComponentName> = ComponentRenderer<GenuiProps<N>>;

const SERIES_COLORS = ["--chart-1", "--chart-2", "--chart-3", "--chart-4", "--chart-5", "--chart-6"];
const seriesColor = (i: number) => `var(${SERIES_COLORS[i % SERIES_COLORS.length]})`;
const CHART_CLASS = "aspect-auto h-56 w-full";

/** Child element nodes as the parser hands them to a parent renderer. */
interface Node<P> {
  props: P;
}
const nodes = <P,>(value: unknown): Node<P>[] =>
  (Array.isArray(value) ? value : []).filter((v): v is Node<P> => !!v && typeof v === "object" && "props" in v);

function useInert(): boolean {
  const settled = useContext(GenuiInertContext);
  const streaming = useIsStreaming();
  return settled || streaming;
}

// Structure.

export const Accordion: R<"Accordion"> = ({ props, renderNode }) => (
  <div className="divide-y divide-border rounded-xl border border-border">{renderNode(props.items)}</div>
);

export const AccordionItem: R<"AccordionItem"> = ({ props, renderNode }) => (
  <details className="group/acc" open={props.open}>
    <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-2.5 text-base font-medium text-foreground [&::-webkit-details-marker]:hidden">
      <ChevronRight className="size-4 shrink-0 transition-transform group-open/acc:rotate-90" aria-hidden />
      {props.title}
    </summary>
    <div className="flex flex-col gap-3 px-4 pb-4">{renderNode(props.children)}</div>
  </details>
);

export const Modal: R<"Modal"> = ({ props, renderNode }) => (
  <Dialog>
    <DialogTrigger asChild>
      <Button type="button" size="sm" variant="outline" className="w-fit text-base">
        {props.label}
      </Button>
    </DialogTrigger>
    <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
      <DialogHeader>
        <DialogTitle>{props.title}</DialogTitle>
      </DialogHeader>
      <div className="flex flex-col gap-3 text-base">{renderNode(props.children)}</div>
    </DialogContent>
  </Dialog>
);

export const Carousel: R<"Carousel"> = ({ props, renderNode }) => (
  <div className="-mx-1 flex snap-x snap-mandatory gap-3 overflow-x-auto px-1 pb-2">
    {nodes<unknown>(props.children).map((child, i) => (
      <div key={i} className="flex w-72 shrink-0 snap-start flex-col [&>*]:flex-1">
        {renderNode(child)}
      </div>
    ))}
  </div>
);

const STEP_ICON = {
  done: <Check className="size-3.5" aria-hidden />,
  current: <CircleDot className="size-3.5" aria-hidden />,
  pending: <Circle className="size-3.5" aria-hidden />,
  failed: <X className="size-3.5" aria-hidden />,
} as const;
const STEP_TONE = {
  done: "border-emerald-500/50 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  current: "border-foreground bg-foreground text-background",
  pending: "border-border text-muted-foreground",
  failed: "border-destructive/50 bg-destructive/10 text-destructive",
} as const;

export const Steps: R<"Steps"> = ({ props, renderNode }) => (
  <ol className="flex flex-col">{renderNode(props.items)}</ol>
);

export const Step: R<"Step"> = ({ props }) => {
  const status = props.status ?? "pending";
  return (
    <li className="relative flex gap-3 pb-4 last:pb-0 [&:last-child>span.rail]:hidden">
      <span className="rail absolute top-7 bottom-0 left-3 w-px bg-border" aria-hidden />
      <span
        className={`relative z-10 flex size-6 shrink-0 items-center justify-center rounded-full border ${STEP_TONE[status]}`}
      >
        {STEP_ICON[status]}
      </span>
      <div className="min-w-0 pt-0.5">
        <p className={`text-base font-medium ${status === "pending" ? "text-muted-foreground" : "text-foreground"}`}>
          {props.title}
        </p>
        {props.description && <p className="text-base text-muted-foreground">{props.description}</p>}
      </div>
    </li>
  );
};

// Media and records.

export const Image: R<"Image"> = ({ props }) => (
  <figure className="flex flex-col gap-1.5">
    <ContentImage
      src={props.src}
      alt={props.alt}
      className="max-h-[28rem] w-auto max-w-full self-start rounded-lg border border-border object-contain"
    />
    {props.caption && <figcaption className="text-base text-muted-foreground">{props.caption}</figcaption>}
  </figure>
);

export const ImageGallery: R<"ImageGallery"> = ({ props }) => (
  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
    {nodes<GenuiProps<"Image">>(props.images).map((img, i) => (
      <figure key={i} className="flex flex-col gap-1">
        <ContentImage
          src={img.props.src}
          alt={img.props.alt}
          className="aspect-square w-full rounded-lg border border-border object-cover"
        />
        {img.props.caption && (
          <figcaption className="truncate text-base text-muted-foreground">{img.props.caption}</figcaption>
        )}
      </figure>
    ))}
  </div>
);

export const EntityList: R<"EntityList"> = ({ props, renderNode }) => (
  <div className="divide-y divide-border rounded-xl border border-border">{renderNode(props.items)}</div>
);

export const Entity: R<"Entity"> = ({ props }) => (
  <div className="flex items-start gap-3 px-4 py-3">
    {props.image && (
      <ContentImage
        src={props.image}
        alt={props.title}
        className="size-10 shrink-0 rounded-md border border-border object-cover"
      />
    )}
    <div className="min-w-0 flex-1">
      <div className="flex items-baseline justify-between gap-3">
        <p className="truncate text-base font-medium text-foreground">{props.title}</p>
        {props.meta && <span className="shrink-0 text-base text-muted-foreground">{props.meta}</span>}
      </div>
      {props.description && <p className="text-base text-muted-foreground">{props.description}</p>}
      {props.tags && props.tags.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {props.tags.map((t) => (
            <span key={t} className="rounded-md border border-border px-1.5 py-0.5 text-base text-muted-foreground">
              {t}
            </span>
          ))}
        </div>
      )}
    </div>
  </div>
);

const JS_LANGS = new Set(["js", "javascript", "ts", "typescript", "jsx", "tsx", "json"]);

export const CodeBlock: R<"CodeBlock"> = ({ props }) => {
  const lang = (props.language ?? "").toLowerCase();
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      {(props.title || props.language) && (
        <div className="flex justify-between gap-2 border-b border-border bg-muted/50 px-3 py-1.5 text-base text-muted-foreground">
          <span className="truncate">{props.title}</span>
          <span className="font-mono">{props.language}</span>
        </div>
      )}
      <pre className="m-0 overflow-x-auto bg-muted p-3 font-mono text-base leading-relaxed">
        <code>{JS_LANGS.has(lang) ? highlightJs(props.code) : props.code}</code>
      </pre>
    </div>
  );
};

// Extra charts.

export const ScatterSeries: R<"ScatterSeries"> = () => null;

export const ScatterChartView: R<"ScatterChart"> = ({ props }) => {
  const { config, series } = useMemo(() => {
    const config: ChartConfig = {};
    const series = nodes<GenuiProps<"ScatterSeries">>(props.series).map((s, i) => {
      config[`s${i}`] = { label: s.props.name, color: seriesColor(i) };
      return {
        key: `s${i}`,
        name: s.props.name,
        data: (s.props.points ?? []).filter((p) => p.length >= 2).map(([x, y]) => ({ x, y })),
      };
    });
    return { config, series };
  }, [props.series]);
  return (
    <ChartContainer config={config} className={CHART_CLASS}>
      <ScatterChart margin={{ left: 0, right: 8, top: 8, bottom: props.xLabel ? 12 : 0 }}>
        <CartesianGrid />
        <XAxis
          type="number"
          dataKey="x"
          name={props.xLabel ?? "x"}
          tickLine={false}
          axisLine={false}
          label={props.xLabel ? { value: props.xLabel, position: "insideBottom", offset: -8 } : undefined}
        />
        <YAxis
          type="number"
          dataKey="y"
          name={props.yLabel ?? "y"}
          tickLine={false}
          axisLine={false}
          width={44}
          label={props.yLabel ? { value: props.yLabel, angle: -90, position: "insideLeft" } : undefined}
        />
        <ZAxis range={[40, 40]} />
        <ChartTooltip content={<ChartTooltipContent className="text-base" />} />
        {series.length > 1 && <ChartLegend content={<ChartLegendContent />} />}
        {series.map((s) => (
          <Scatter key={s.key} name={s.key} data={s.data} fill={`var(--color-${s.key})`} />
        ))}
      </ScatterChart>
    </ChartContainer>
  );
};

export const RadarChartView: R<"RadarChart"> = ({ props }) => {
  const { rows, config, keys } = useMemo(() => {
    const list = nodes<GenuiProps<"Series">>(props.series);
    const config: ChartConfig = {};
    list.forEach((s, i) => {
      config[`s${i}`] = { label: s.props.name, color: seriesColor(i) };
    });
    const rows = props.labels.map((label, i) => {
      const row: Record<string, unknown> = { label };
      list.forEach((s, j) => {
        row[`s${j}`] = s.props.values?.[i] ?? 0;
      });
      return row;
    });
    return { rows, config, keys: list.map((_, i) => `s${i}`) };
  }, [props.labels, props.series]);
  return (
    <ChartContainer config={config} className="aspect-auto h-64 w-full">
      <RadarChart data={rows}>
        <PolarGrid />
        <PolarAngleAxis dataKey="label" />
        <ChartTooltip content={<ChartTooltipContent className="text-base" />} />
        {keys.length > 1 && <ChartLegend content={<ChartLegendContent />} />}
        {keys.map((k) => (
          <Radar key={k} dataKey={k} stroke={`var(--color-${k})`} fill={`var(--color-${k})`} fillOpacity={0.25} />
        ))}
      </RadarChart>
    </ChartContainer>
  );
};

export const RadialChartView: R<"RadialChart"> = ({ props }) => {
  const max = props.max && props.max > 0 ? props.max : 100;
  const { rows, config } = useMemo(() => {
    const config: ChartConfig = {};
    const rows = props.labels.map((label, i) => {
      config[`p${i}`] = { label, color: seriesColor(i) };
      return { key: `p${i}`, value: props.values[i] ?? 0, fill: `var(--color-p${i})` };
    });
    return { rows, config };
  }, [props.labels, props.values]);
  return (
    <ChartContainer config={config} className={CHART_CLASS}>
      <RadialBarChart data={rows} innerRadius="25%" outerRadius="100%" startAngle={90} endAngle={-270}>
        <ChartTooltip content={<ChartTooltipContent nameKey="key" hideLabel className="text-base" />} />
        <RadialBar dataKey="value" background cornerRadius={4} />
        <ChartLegend content={<ChartLegendContent nameKey="key" />} />
        {/* The domain of every ring: values are out of `max`. */}
        <PolarAngleAxisForMax max={max} />
      </RadialBarChart>
    </ChartContainer>
  );
};

function PolarAngleAxisForMax({ max }: { max: number }) {
  return <PolarAngleAxis type="number" domain={[0, max]} tick={false} />;
}

export const StackedBar: R<"StackedBar"> = ({ props }) => {
  const total = props.values.reduce((a, b) => a + (b > 0 ? b : 0), 0);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-muted">
        {props.values.map((v, i) =>
          v > 0 && total > 0 ? (
            <div
              key={i}
              style={{ width: `${(v / total) * 100}%`, background: seriesColor(i) }}
              title={`${props.labels[i] ?? ""}: ${v}`}
            />
          ) : null,
        )}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-base text-muted-foreground">
        {props.labels.map((label, i) => (
          <span key={i} className="flex items-center gap-1.5">
            <span className="size-2 rounded-sm" style={{ background: seriesColor(i) }} />
            {label}
            <span className="tabular-nums text-foreground">
              {props.values[i] ?? 0}
              {total > 0 ? ` (${Math.round(((props.values[i] ?? 0) / total) * 100)}%)` : ""}
            </span>
          </span>
        ))}
      </div>
    </div>
  );
};

// Follow-ups: each chip sends its text as the user's next message.

export const FollowUps: R<"FollowUps"> = ({ props }) => {
  const triggerAction = useTriggerAction();
  const inert = useInert();
  const answer = useContext(GenuiAnswerContext);
  return (
    <div className="flex flex-wrap gap-2">
      {props.items.map((text) => {
        const chosen = answeredBy(answer, text);
        return (
          <button
            key={text}
            type="button"
            disabled={inert}
            aria-pressed={chosen || undefined}
            onClick={() => void triggerAction(text)}
            className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-base transition-colors disabled:cursor-default ${
              chosen
                ? "border-foreground text-foreground"
                : "border-border text-muted-foreground enabled:hover:bg-accent enabled:hover:text-foreground disabled:opacity-60"
            }`}
          >
            {chosen && <Check className="size-3.5" aria-hidden />}
            {text}
          </button>
        );
      })}
    </div>
  );
};

// Form inputs. Every value lives in the renderer's form state under the
// field's name, so a button's @ToAssistant submits it.

export const RadioGroup: R<"RadioGroup"> = ({ props }) => {
  const field = useStateField<string>(props.name, props.value);
  const inert = useInert();
  return (
    <div role="radiogroup" className="flex flex-col gap-1.5">
      {props.options.map((o) => (
        <label key={o} className="flex cursor-pointer items-center gap-2 text-base">
          <input
            type="radio"
            name={field.name}
            className="size-4 accent-foreground"
            checked={field.value === o}
            disabled={inert}
            onChange={() => field.setValue(o)}
          />
          {o}
        </label>
      ))}
    </div>
  );
};

export const CheckBoxGroup: R<"CheckBoxGroup"> = ({ props }) => {
  const field = useStateField<string[]>(props.name, props.value);
  const inert = useInert();
  const selected = Array.isArray(field.value) ? (field.value as string[]) : [];
  return (
    <div className="flex flex-col gap-1.5">
      {props.options.map((o) => (
        <label key={o} className="flex cursor-pointer items-center gap-2 text-base">
          <input
            type="checkbox"
            className="size-4 accent-foreground"
            checked={selected.includes(o)}
            disabled={inert}
            onChange={(e) => field.setValue(e.target.checked ? [...selected, o] : selected.filter((v) => v !== o))}
          />
          {o}
        </label>
      ))}
    </div>
  );
};

export const Switch: R<"Switch"> = ({ props }) => {
  const field = useStateField<boolean>(props.name, props.value);
  const inert = useInert();
  const on = field.value === true;
  return (
    <label className="flex cursor-pointer items-center gap-2.5 text-base">
      <button
        type="button"
        role="switch"
        aria-checked={on}
        disabled={inert}
        onClick={() => field.setValue(!on)}
        className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-60 ${
          on ? "bg-foreground" : "bg-input"
        }`}
      >
        <span
          className={`inline-block size-4 rounded-full bg-background shadow transition-transform ${
            on ? "translate-x-4.5" : "translate-x-0.5"
          }`}
        />
      </button>
      {props.label}
    </label>
  );
};

export const Slider: R<"Slider"> = ({ props }) => {
  const field = useStateField<number>(props.name, props.value ?? props.min);
  const inert = useInert();
  const value = typeof field.value === "number" ? field.value : props.min;
  return (
    <div className="flex items-center gap-3">
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step ?? 1}
        value={value}
        disabled={inert}
        onChange={(e) => field.setValue(Number(e.target.value))}
        className="h-2 flex-1 cursor-pointer accent-foreground disabled:opacity-60"
      />
      <span className="min-w-14 text-right text-base tabular-nums text-foreground">
        {value}
        {props.unit ? ` ${props.unit}` : ""}
      </span>
    </div>
  );
};

const DATE_TYPE = { date: "date", time: "time", datetime: "datetime-local", month: "month" } as const;

export const DatePicker: R<"DatePicker"> = ({ props }) => {
  const field = useStateField<string>(props.name, props.value);
  const inert = useInert();
  return (
    <Input
      id={field.name}
      name={field.name}
      type={DATE_TYPE[props.kind ?? "date"]}
      min={props.min}
      max={props.max}
      value={(field.value as string | undefined) ?? ""}
      disabled={inert}
      onChange={(e) => field.setValue(e.target.value)}
      className="w-fit text-base"
    />
  );
};

/** The selection of a single- or multi-choice field as a list. */
function selection(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  return typeof value === "string" && value !== "" ? [value] : [];
}

function toggle(current: string[], value: string, multiple: boolean): string | string[] {
  if (!multiple) return value;
  return current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
}

export const OptionCards: R<"OptionCards"> = ({ props }) => {
  const field = useStateField<string | string[]>(props.name, props.value);
  const inert = useInert();
  const selected = selection(field.value);
  const options = nodes<GenuiProps<"OptionCard">>(props.options);
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {options.map(({ props: o }) => {
        const on = selected.includes(o.value);
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={on}
            disabled={inert}
            onClick={() => field.setValue(toggle(selected, o.value, !!props.multiple))}
            className={`flex flex-col items-start gap-0.5 rounded-lg border px-3 py-2.5 text-left transition-colors disabled:cursor-default ${
              on ? "border-foreground bg-accent" : "border-border enabled:hover:bg-accent/50"
            } ${inert && !on ? "opacity-60" : ""}`}
          >
            <span className="flex w-full items-center justify-between gap-2 text-base font-medium text-foreground">
              {o.title}
              {on && <Check className="size-4 shrink-0" aria-hidden />}
            </span>
            {o.description && <span className="text-base text-muted-foreground">{o.description}</span>}
          </button>
        );
      })}
    </div>
  );
};

export const OptionCard: R<"OptionCard"> = ({ props }) => (
  <div className="rounded-lg border border-border px-3 py-2 text-base">{props.title}</div>
);

export const Chips: R<"Chips"> = ({ props }) => {
  const field = useStateField<string | string[]>(props.name, props.value);
  const inert = useInert();
  const selected = selection(field.value);
  return (
    <div className="flex flex-wrap gap-1.5">
      {props.options.map((o) => {
        const on = selected.includes(o);
        return (
          <button
            key={o}
            type="button"
            aria-pressed={on}
            disabled={inert}
            onClick={() => field.setValue(toggle(selected, o, !!props.multiple))}
            className={`rounded-full border px-3 py-1 text-base transition-colors disabled:cursor-default ${
              on
                ? "border-foreground bg-foreground text-background"
                : "border-border text-muted-foreground enabled:hover:bg-accent"
            } ${inert && !on ? "opacity-60" : ""}`}
          >
            {o}
          </button>
        );
      })}
    </div>
  );
};

type CellValue = string | number | boolean | null;

export const EditableTable: R<"EditableTable"> = ({ props }) => {
  const field = useStateField<CellValue[][]>(props.name, props.rows);
  const inert = useInert();
  const rows: CellValue[][] = Array.isArray(field.value) ? (field.value as CellValue[][]) : [];
  const set = (r: number, c: number, text: string) => {
    const next = rows.map((row) => [...row]);
    const was = next[r]![c];
    next[r]![c] = typeof was === "number" && text.trim() !== "" && !Number.isNaN(Number(text)) ? Number(text) : text;
    field.setValue(next);
  };
  return (
    <div className="flex flex-col gap-2">
      <div className="max-w-full overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-base">
          <thead>
            <tr>
              {props.columns.map((c, i) => (
                <th key={i} className="border-b-2 border-border px-2 py-1.5 text-left text-base font-semibold">
                  {c}
                </th>
              ))}
              {props.addRows && !inert && <th className="w-8 border-b-2 border-border" />}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, r) => (
              <tr key={r}>
                {props.columns.map((_, c) => (
                  <td key={c} className="border-t border-border p-0">
                    <input
                      value={row[c] === null || row[c] === undefined ? "" : String(row[c])}
                      disabled={inert}
                      onChange={(e) => set(r, c, e.target.value)}
                      aria-label={`${props.columns[c]} row ${r + 1}`}
                      className="w-full min-w-20 bg-transparent px-2 py-1.5 text-base outline-none focus:bg-accent disabled:cursor-default"
                    />
                  </td>
                ))}
                {props.addRows && !inert && (
                  <td className="border-t border-border text-center">
                    <button
                      type="button"
                      aria-label={`Remove row ${r + 1}`}
                      onClick={() => field.setValue(rows.filter((_, i) => i !== r))}
                      className="rounded p-1 text-muted-foreground hover:text-foreground"
                    >
                      <Trash2 className="size-3" aria-hidden />
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {props.addRows && !inert && (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="w-fit text-base"
          onClick={() => field.setValue([...rows, props.columns.map(() => "")])}
        >
          <Plus className="size-3.5" aria-hidden />
          Add row
        </Button>
      )}
    </div>
  );
};
