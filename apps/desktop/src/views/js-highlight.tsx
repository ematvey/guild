import type { ReactNode } from "react";

/// Minimal JavaScript tokenizer for display-only highlighting (codemode
/// script blocks). One regex pass; no dependencies, no per-language grammars.
/// Unsupported constructs (regex literals, nested template interpolations)
/// fall through as plain text — harmless, since this is decoration only.

const KEYWORDS = new Set([
  "async", "await", "break", "case", "catch", "class", "const", "continue",
  "debugger", "default", "delete", "do", "else", "export", "extends", "false",
  "finally", "for", "from", "function", "if", "import", "in", "instanceof",
  "let", "new", "null", "of", "return", "static", "super", "switch", "this",
  "throw", "true", "try", "typeof", "undefined", "var", "void", "while",
  "yield",
]);

const GLOBALS = new Set([
  "AggregateError", "Array", "Atomics", "BigInt", "Boolean", "console",
  "crypto", "DataView", "Date", "Error", "EvalError", "FinalizationRegistry",
  "Float32Array", "Float64Array", "Function", "Infinity", "Int16Array",
  "Int32Array", "Int8Array", "Intl", "JSON", "Map", "Math", "NaN", "Number",
  "Object", "Promise", "Proxy", "RangeError", "ReferenceError", "Reflect",
  "RegExp", "Set", "SharedArrayBuffer", "String", "Symbol", "SyntaxError",
  "TypeError", "URIError", "Uint16Array", "Uint32Array", "Uint8Array",
  "Uint8ClampedArray", "WeakMap", "WeakRef", "WeakSet", "globalThis",
  "structuredClone",
]);

const TOKEN_RE = new RegExp(
  [
    "(\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/)", // 1 comment
    "('(?:\\\\.|[^'\\\\\\n])*'|\"(?:\\\\.|[^\"\\\\\\n])*\"|`(?:\\\\.|[^`\\\\])*`)", // 2 string
    "(\\b0[xXbBoO][\\da-fA-F_]+\\b|\\b\\d[\\d_]*(?:\\.\\d[\\d_]*)?(?:[eE][+-]?\\d+)?n?\\b)", // 3 number
    "([A-Za-z_$][\\w$]*)", // 4 identifier
    "(\\s+)", // 5 whitespace
    "(.)", // 6 anything else
  ].join("|"),
  "g",
);

const CLASS = {
  comment: "text-muted-foreground/50 italic",
  string: "text-emerald-700 dark:text-emerald-300",
  number: "text-amber-700 dark:text-amber-300",
  keyword: "text-violet-700 dark:text-violet-300",
  builtin: "text-sky-700 dark:text-sky-300",
  fn: "text-sky-700 dark:text-sky-300 font-medium",
} as const;

type Kind = keyof typeof CLASS;

export function highlightJs(code: string): ReactNode {
  const out: ReactNode[] = [];
  let key = 0;
  let plain = "";
  const flush = () => {
    if (plain) {
      out.push(plain);
      plain = "";
    }
  };
  for (let m = TOKEN_RE.exec(code); m; m = TOKEN_RE.exec(code)) {
    const [text, comment, str, num, ident, ws] = m;
    if (ws || !(comment || str || num || ident)) {
      plain += text;
      continue;
    }
    let kind: Kind | null = null;
    if (comment) kind = "comment";
    else if (str) kind = "string";
    else if (num) kind = "number";
    else if (ident) {
      if (KEYWORDS.has(ident)) kind = "keyword";
      else if (GLOBALS.has(ident)) kind = "builtin";
      else if (/^\s*\(/.test(code.slice(m.index + text.length))) kind = "fn";
        else {
        plain += text;
        continue;
      }
    }
    flush();
    out.push(
      <span key={key++} className={CLASS[kind!]}>
        {text}
      </span>,
    );
  }
  flush();
  return out;
}
