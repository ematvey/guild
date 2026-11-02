// Readable JSON for span input, output and attributes: syntax colors,
// collapsible objects and arrays, expand/collapse-all controls, and a
// plain-text fallback.

import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@guild/ui/lib/utils";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type OpenMode = "default" | "all" | "none";

function parse(value: string): Json | undefined {
  const text = value.trim();
  if (text === "") return undefined;
  try {
    return JSON.parse(text) as Json;
  } catch {
    return undefined;
  }
}

const MAX_RENDER_CHARS = 80_000;

export function JsonView({
  value,
  className,
  maxHeight = "max-h-[26rem]",
}: {
  value: string;
  className?: string;
  maxHeight?: string;
}) {
  const parsed = useMemo(() => parse(value), [value]);
  const [mode, setMode] = useState<OpenMode>("default");
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    setMode("default");
    setRevision((current) => current + 1);
  }, [value]);

  if (parsed === undefined) {
    return (
      <pre
        className={cn(
          "overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/30 p-3 font-mono text-2xs leading-5 text-foreground",
          maxHeight,
          className,
        )}
      >
        {value.trim() === "" ? "—" : value}
      </pre>
    );
  }
  if (value.length > MAX_RENDER_CHARS) {
    return (
      <div className={cn("space-y-2", className)}>
        <p className="text-2xs text-muted-foreground">
          {value.length.toLocaleString()} characters. The JSON tree is off for large payloads.
        </p>
        <pre
          className={cn(
            "overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/30 p-3 font-mono text-2xs leading-5",
            maxHeight,
          )}
        >
          {value.slice(0, MAX_RENDER_CHARS)}
        </pre>
      </div>
    );
  }

  const expandable = typeof parsed === "object" && parsed !== null;
  const apply = (next: OpenMode) => {
    setMode(next);
    setRevision((current) => current + 1);
  };

  return (
    <div className={cn("overflow-hidden rounded-md bg-muted/30", className)}>
      {expandable && (
        <div className="flex items-center gap-1 border-b border-border/40 px-2 py-1">
          <span className="mr-auto text-2xs uppercase tracking-wide text-muted-foreground">JSON</span>
          <button
            type="button"
            onClick={() => apply("all")}
            className="rounded px-1.5 py-0.5 text-2xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            Expand all
          </button>
          <span className="text-2xs text-border">·</span>
          <button
            type="button"
            onClick={() => apply("none")}
            className="rounded px-1.5 py-0.5 text-2xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            Collapse all
          </button>
        </div>
      )}
      <div className={cn("overflow-auto p-3 font-mono text-2xs leading-5 text-foreground", maxHeight)}>
        <JsonNode value={parsed} depth={0} name={null} arrayIndex={false} isLast mode={mode} revision={revision} />
      </div>
    </div>
  );
}

function JsonNode({
  value,
  depth,
  name,
  arrayIndex,
  isLast,
  mode,
  revision,
}: {
  value: Json;
  depth: number;
  name: string | null;
  arrayIndex: boolean;
  isLast: boolean;
  mode: OpenMode;
  revision: number;
}) {
  const initialOpen = mode === "all" ? true : mode === "none" ? depth === 0 : depth < 2;
  const [open, setOpen] = useState(initialOpen);
  useEffect(() => {
    setOpen(initialOpen);
  }, [initialOpen, revision]);

  const isArray = Array.isArray(value);
  const isObject = typeof value === "object" && value !== null && !isArray;
  const entries: [string, Json][] = isArray
    ? value.map((child, index) => [String(index), child])
    : isObject
      ? Object.entries(value as { [key: string]: Json })
      : [];

  const prefix =
    name === null ? null : arrayIndex ? (
      <span className="text-muted-foreground">{name}: </span>
    ) : (
      <>
        <span className="text-violet-300">&quot;{name}&quot;</span>
        <span className="text-muted-foreground">: </span>
      </>
    );

  if (!isArray && !isObject) {
    return (
      <div className="break-words">
        {prefix}
        <Primitive value={value} />
        {!isLast && <span className="text-muted-foreground">,</span>}
      </div>
    );
  }

  const openBracket = isArray ? "[" : "{";
  const closeBracket = isArray ? "]" : "}";
  if (entries.length === 0) {
    return (
      <div>
        {prefix}
        <span className="text-muted-foreground">
          {openBracket}
          {closeBracket}
        </span>
        {!isLast && <span className="text-muted-foreground">,</span>}
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-start gap-1">
        <button
          type="button"
          aria-label={open ? "Collapse value" : "Expand value"}
          onClick={() => setOpen((current) => !current)}
          className="mt-0.5 flex size-3.5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        </button>
        <div className="min-w-0">
          {prefix}
          <span className="text-muted-foreground">{openBracket}</span>
          {!open && (
            <span className="text-muted-foreground">
              …{closeBracket}
              {!isLast ? "," : ""}
            </span>
          )}
        </div>
      </div>
      {open && (
        <>
          <div className="ml-[7px] border-l border-border/60 pl-2">
            {entries.map(([key, child], index) => (
              <JsonNode
                key={key}
                value={child}
                depth={depth + 1}
                name={key}
                arrayIndex={isArray}
                isLast={index === entries.length - 1}
                mode={mode}
                revision={revision}
              />
            ))}
          </div>
          <div className="pl-[18px] text-muted-foreground">
            {closeBracket}
            {!isLast ? "," : ""}
          </div>
        </>
      )}
    </div>
  );
}

function Primitive({ value }: { value: Json }) {
  if (value === null) return <span className="text-muted-foreground">null</span>;
  if (typeof value === "string") {
    return <span className="break-words text-emerald-300">&quot;{value}&quot;</span>;
  }
  if (typeof value === "number") return <span className="text-amber-300">{String(value)}</span>;
  if (typeof value === "boolean") return <span className="text-rose-300">{String(value)}</span>;
  return <span className="text-muted-foreground">{String(value)}</span>;
}
