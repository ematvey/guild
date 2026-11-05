// The Generated UI component set: every component an agent may instantiate
// in an `openui` block, as OpenUI Lang definitions (name, description,
// positional props). Renderer-agnostic: the server builds the prompt from
// it with no renderer at all, the desktop supplies a React renderer per
// component. Children slots are layered (content < grid < card < tabs <
// stack) so the schemas stay acyclic.

import { action, createLibrary, defineComponent, tagSchemaId, type Library } from "@openuidev/lang-core";
import { z } from "zod/v4";

const tone = z.enum(["neutral", "info", "success", "warning", "danger"]);

/** Form-field validation rules, checked before a primary button's action. */
const rulesObject = z.object({
  required: z.boolean().optional(),
  email: z.boolean().optional(),
  url: z.boolean().optional(),
  numeric: z.boolean().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  minLength: z.number().optional(),
  maxLength: z.number().optional(),
  pattern: z.string().optional(),
});
tagSchemaId(rulesObject, "Rules");
const rules = rulesObject.optional();

const cell = z.union([z.string(), z.number(), z.boolean(), z.null()]);

// Leaf content.
export const TextProps = z.object({
  text: z.string(),
  variant: z.enum(["body", "muted", "title", "subtitle"]).optional(),
});
export const MetricProps = z.object({
  label: z.string(),
  value: z.union([z.string(), z.number()]),
  delta: z.string().optional(),
  trend: z.enum(["up", "down", "flat"]).optional(),
});
export const TableProps = z.object({
  columns: z.array(z.string()),
  rows: z.array(z.array(cell)),
  caption: z.string().optional(),
});
export const SeriesProps = z.object({
  name: z.string(),
  values: z.array(z.number()),
});
export const BarChartProps = z.object({
  labels: z.array(z.string()),
  series: z.array(SeriesProps),
  stacked: z.boolean().optional(),
});
export const LineChartProps = z.object({
  labels: z.array(z.string()),
  series: z.array(SeriesProps),
  area: z.boolean().optional(),
});
export const PieChartProps = z.object({
  labels: z.array(z.string()),
  values: z.array(z.number()),
});
export const CalloutProps = z.object({
  text: z.string(),
  tone: tone.optional(),
  title: z.string().optional(),
});
export const ListProps = z.object({
  items: z.array(z.string()),
  ordered: z.boolean().optional(),
});
export const ProgressProps = z.object({
  label: z.string(),
  value: z.number(),
  max: z.number().optional(),
});
export const FactProps = z.object({
  label: z.string(),
  value: z.union([z.string(), z.number()]),
});
export const FactsProps = z.object({ items: z.array(FactProps) });
export const TagProps = z.object({ text: z.string(), tone: tone.optional() });
export const TagsProps = z.object({ items: z.array(TagProps) });
export const SeparatorProps = z.object({});
export const ButtonProps = z.object({
  label: z.string(),
  action: action().optional(),
  variant: z.enum(["primary", "secondary", "destructive"]).optional(),
});
export const ButtonsProps = z.object({ items: z.array(ButtonProps) });

// Form fields.
export const InputProps = z.object({
  name: z.string(),
  placeholder: z.string().optional(),
  type: z.enum(["text", "email", "number", "url", "date"]).optional(),
  rules,
  value: z.string().optional(),
});
export const TextAreaProps = z.object({
  name: z.string(),
  placeholder: z.string().optional(),
  rules,
  value: z.string().optional(),
});
export const SelectProps = z.object({
  name: z.string(),
  options: z.array(z.string()),
  placeholder: z.string().optional(),
  rules,
  value: z.string().optional(),
});
export const CheckboxProps = z.object({
  name: z.string(),
  label: z.string(),
  value: z.boolean().optional(),
});
export const FieldProps = z.object({
  label: z.string(),
  input: z.union([InputProps, TextAreaProps, SelectProps, CheckboxProps]),
  hint: z.string().optional(),
});
export const FormProps = z.object({
  name: z.string(),
  fields: z.array(FieldProps),
  buttons: ButtonsProps,
});

const content = [
  TextProps,
  MetricProps,
  TableProps,
  BarChartProps,
  LineChartProps,
  PieChartProps,
  CalloutProps,
  ListProps,
  ProgressProps,
  FactsProps,
  TagsProps,
  SeparatorProps,
  ButtonsProps,
  FormProps,
] as const;

export const GridProps = z.object({
  children: z.array(z.union(content)),
  columns: z.number().optional(),
});
export const CardProps = z.object({
  children: z.array(z.union([...content, GridProps])),
  title: z.string().optional(),
  description: z.string().optional(),
});
export const TabProps = z.object({
  label: z.string(),
  children: z.array(z.union([...content, GridProps, CardProps])),
});
export const TabsProps = z.object({ items: z.array(TabProps) });
export const StackProps = z.object({
  children: z.array(z.union([...content, GridProps, CardProps, TabsProps])),
  direction: z.enum(["column", "row"]).optional(),
});

/** Every component: its props schema and the description the model reads. */
export const GENUI_COMPONENTS = {
  Stack: {
    props: StackProps,
    description: 'Root container. Lays children out top to bottom, or side by side with direction "row".',
  },
  Card: { props: CardProps, description: "Bordered panel grouping related content under an optional title." },
  Tabs: { props: TabsProps, description: "Tabbed views; one Tab per view." },
  Tab: { props: TabProps, description: "One view of Tabs: its label and content." },
  Grid: {
    props: GridProps,
    description: "Responsive grid of equal columns (default 3; collapses on narrow screens). Use for rows of Metrics.",
  },
  Text: {
    props: TextProps,
    description: "A paragraph. Inline Markdown (bold, italics, links, `code`) is allowed.",
  },
  Metric: {
    props: MetricProps,
    description: 'A key number: label, value, optional change ("+12%") and its trend.',
  },
  Table: {
    props: TableProps,
    description: "Data table: column headers and rows of cells, one cell per column.",
  },
  Series: { props: SeriesProps, description: "A named numeric series, one value per chart label." },
  BarChart: {
    props: BarChartProps,
    description: "Bar chart comparing series across categories (labels).",
  },
  LineChart: {
    props: LineChartProps,
    description: "Line chart of series over an ordered axis (labels, e.g. dates); area fills under the lines.",
  },
  PieChart: { props: PieChartProps, description: "Pie chart of parts of a whole: one value per label." },
  Callout: {
    props: CalloutProps,
    description: "Highlighted note: a status, warning or key takeaway.",
  },
  List: { props: ListProps, description: "Bulleted (or numbered) list of short items." },
  Progress: { props: ProgressProps, description: "Progress bar: value out of max (default 100)." },
  Facts: { props: FactsProps, description: "Label/value pairs, e.g. the attributes of one record." },
  Fact: { props: FactProps, description: "One label/value pair of Facts." },
  Tags: { props: TagsProps, description: "A row of small status labels." },
  Tag: { props: TagProps, description: "One small status label." },
  Separator: { props: SeparatorProps, description: "Horizontal divider." },
  Buttons: { props: ButtonsProps, description: "A row of buttons." },
  Button: {
    props: ButtonProps,
    description: 'Clickable button. Its action is usually @ToAssistant("message") — the user\'s next message.',
  },
  Form: {
    props: FormProps,
    description:
      "Form: fields and its buttons. A button's @ToAssistant sends the message together with every field value.",
  },
  Field: { props: FieldProps, description: "A labelled form field wrapping one input." },
  Input: { props: InputProps, description: "Single-line text input." },
  TextArea: { props: TextAreaProps, description: "Multi-line text input." },
  Select: { props: SelectProps, description: "Dropdown choosing one of options." },
  Checkbox: { props: CheckboxProps, description: "A checkbox with its label." },
} as const;

export type GenuiComponentName = keyof typeof GENUI_COMPONENTS;
export type GenuiProps<N extends GenuiComponentName> = z.infer<(typeof GENUI_COMPONENTS)[N]["props"]>;

/** The library with one renderer per component. The server passes `null`
 *  for every renderer (it only generates the prompt); a client passes its
 *  real components. */
export function genuiLibrary<C>(renderers: { [N in GenuiComponentName]: C }): Required<Library<C>> {
  const components = (Object.keys(GENUI_COMPONENTS) as GenuiComponentName[]).map((name) =>
    defineComponent({
      name,
      props: GENUI_COMPONENTS[name].props,
      description: GENUI_COMPONENTS[name].description,
      component: renderers[name],
    }),
  );
  return createLibrary<C>({
    root: "Stack",
    components,
    componentGroups: [
      { name: "Layout", components: ["Stack", "Card", "Grid", "Tabs", "Tab", "Separator"] },
      {
        name: "Content",
        components: ["Text", "Metric", "Callout", "List", "Facts", "Fact", "Tags", "Tag", "Progress"],
      },
      { name: "Data", components: ["Table", "BarChart", "LineChart", "PieChart", "Series"] },
      {
        name: "Interaction",
        components: ["Buttons", "Button", "Form", "Field", "Input", "TextArea", "Select", "Checkbox"],
        notes: [
          "Use @ToAssistant for buttons; the click becomes the user's next message to you.",
          "@OpenUrl(url) opens a link in the user's browser.",
          "Rules = {required?: boolean, email?: boolean, url?: boolean, numeric?: boolean, min?: number, max?: number, minLength?: number, maxLength?: number, pattern?: string}; a primary button checks them before its action runs.",
          "A field's value argument is its initial value.",
        ],
      },
    ],
  });
}
