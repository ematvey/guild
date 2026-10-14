// Exec-policy rules parser (crates/codex-execpolicy parser.rs subset + the
// build.rs loading shape): the base rules load from the static Rust asset
// (apps/server/assets/exec_policy_base.rules) and an optional deployment
// local layer (exec_policy_local.rules next to it) merges after it — a
// broken local layer degrades to base-only with a warning, like build.rs.
//
// The Starlark subset: `prefix_rule(pattern=[…], decision=…,
// justification=…)` calls with string or string-list pattern elements (a
// list = alternatives, PatternToken::Alts). `network_rule` and
// `host_executable` are accepted for forward compatibility and ignored: the
// gate evaluates prefix rules only, exactly like the Rust runtime path.

export type DecisionKind = "allow" | "prompt" | "forbidden";

export type PatternToken =
  | { single: string }
  | { alts: string[] };

export interface PrefixRuleSpec {
  first: string;
  rest: PatternToken[];
  decision: DecisionKind;
  justification: string | null;
}

export class RulesParseError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(`line ${line}: ${message}`);
  }
}

interface RawCall {
  line: number;
  name: string;
  /** Raw argument text of one balanced `name(...)` call. */
  args: string;
}

/** Tokenizes the file into top-level `ident(...)` calls (comments and
 *  whitespace skipped; strings may contain anything except an unescaped
 *  delimiter of their own). */
function scanCalls(src: string): RawCall[] {
  const calls: RawCall[] = [];
  let i = 0;
  let line = 1;
  const n = src.length;
  while (i < n) {
    // line tracks the position of `i`; the call scan advances it separately.
    const c = src[i]!;
    if (c === "\n") {
      line += 1;
      i += 1;
      continue;
    }
    if (c === "#") {
      // Comment: skip to end of line.
      while (i < n && src[i] !== "\n") i += 1;
      continue;
    }
    if (/\s/.test(c)) {
      i += 1;
      continue;
    }
    if (!/[A-Za-z_]/.test(c)) {
      throw new RulesParseError(`unexpected character ${JSON.stringify(c)}`, line);
    }
    const startLine = line;
    let j = i;
    while (j < n && /[A-Za-z0-9_]/.test(src[j]!)) j += 1;
    const name = src.slice(i, j);
    let k = j;
    while (k < n && /\s/.test(src[k]!)) {
      if (src[k] === "\n") line += 1;
      k += 1;
    }
    if (src[k] !== "(") {
      throw new RulesParseError(`expected ( after ${name}`, line);
    }
    // Balanced-paren scan, string-aware; an unterminated call is an error.
    let depth = 0;
    let inString: string | null = null;
    let closed = -1;
    for (let p = k; p < n; p++) {
      const ch = src[p]!;
      if (inString !== null) {
        if (ch === "\\") p += 1;
        else if (ch === inString) inString = null;
        continue;
      }
      if (ch === '"' || ch === "'") {
        inString = ch;
      } else if (ch === "(") {
        depth += 1;
      } else if (ch === ")") {
        depth -= 1;
        if (depth === 0) {
          closed = p;
          break;
        }
      }
    }
    if (closed === -1) {
      throw new RulesParseError(`unterminated call ${name}`, startLine);
    }
    calls.push({ line: startLine, name, args: src.slice(k + 1, closed) });
    i = closed + 1;
  }
  return calls;
}

/** Splits `a, b, c` argument text at top-level commas (string- and
 *  bracket-aware). */
function splitArgs(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inString: string | null = null;
  let current = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString !== null) {
      current += ch;
      if (ch === "\\") {
        current += text[i + 1] ?? "";
        i += 1;
      } else if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = ch;
      current += ch;
    } else if (ch === "[" || ch === "(") {
      depth += 1;
      current += ch;
    } else if (ch === "]" || ch === ")") {
      depth -= 1;
      current += ch;
    } else if (ch === "," && depth === 0) {
      out.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim() !== "") out.push(current);
  return out;
}

function unquote(raw: string, line: number): string {
  const s = raw.trim();
  if (s.length < 2 || (s[0] !== '"' && s[0] !== "'") || s[s.length - 1] !== s[0]) {
    throw new RulesParseError(`expected a quoted string, got ${s}`, line);
  }
  const body = s.slice(1, -1);
  // Starlark escapes: the rules files use plain text; handle the common
  // backslash escapes literally.
  return body.replace(/\\(.)/g, (_m, ch: string) => {
    switch (ch) {
      case "n":
        return "\n";
      case "t":
        return "\t";
      case "r":
        return "\r";
      case "\\":
        return "\\";
      case '"':
        return '"';
      case "'":
        return "'";
      default:
        return ch;
    }
  });
}

/** Parses a pattern element: a quoted string or a list of quoted strings
 *  (alternatives). */
function parsePatternElement(raw: string, line: number): PatternToken {
  const s = raw.trim();
  if (s.startsWith("[")) {
    if (!s.endsWith("]")) throw new RulesParseError("unterminated alternatives list", line);
    const inner = s.slice(1, -1);
    const alts = splitArgs(inner).map((a) => unquote(a, line));
    if (alts.length === 0) throw new RulesParseError("pattern alternatives cannot be empty", line);
    return { alts };
  }
  return { single: unquote(s, line) };
}

function parsePatternList(raw: string, line: number): PatternToken[] {
  const s = raw.trim();
  if (!s.startsWith("[") || !s.endsWith("]")) {
    throw new RulesParseError("pattern must be a list", line);
  }
  const elements = splitArgs(s.slice(1, -1));
  if (elements.length === 0) throw new RulesParseError("pattern cannot be empty", line);
  return elements.map((e) => parsePatternElement(e, line));
}

function parseDecision(raw: string | undefined, line: number): DecisionKind {
  if (raw === undefined) return "allow"; // Rust: decision defaults to Allow
  const s = unquote(raw, line);
  if (s === "allow" || s === "prompt" || s === "forbidden") return s;
  throw new RulesParseError(`invalid decision ${s}`, line);
}

function parseKeywordArgs(args: string, line: number): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of splitArgs(args)) {
    const eq = indexOfTopLevelEq(part);
    if (eq === -1) throw new RulesParseError(`positional arguments are not supported: ${part.trim()}`, line);
    const name = part.slice(0, eq).trim();
    out.set(name, part.slice(eq + 1).trim());
  }
  return out;
}

function indexOfTopLevelEq(text: string): number {
  let depth = 0;
  let inString: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString !== null) {
      if (ch === "\\") i += 1;
      else if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'") inString = ch;
    else if (ch === "[" || ch === "(") depth += 1;
    else if (ch === "]" || ch === ")") depth -= 1;
    else if (ch === "=" && depth === 0 && text[i + 1] !== "=") return i;
  }
  return -1;
}

export interface RuleMatchExample {
  /** The rule specs this validation belongs to (one prefix_rule call). */
  rules: PrefixRuleSpec[];
  matches: string[][];
  notMatches: string[][];
}

/** Parses one policy file into prefix-rule specs. `match`/`not_match`
 *  example validations ride the spec (validated against the matcher after
 *  the file's rules are assembled, like the Rust pending validations). */
export function parseRulesFile(src: string): { rules: PrefixRuleSpec[]; validations: RuleMatchExample[] } {
  const rules: PrefixRuleSpec[] = [];
  const validations: RuleMatchExample[] = [];
  for (const call of scanCalls(src)) {
    if (call.name === "prefix_rule") {
      const args = parseKeywordArgs(call.args, call.line);
      const pattern = args.get("pattern");
      if (pattern === undefined) throw new RulesParseError("missing pattern", call.line);
      const tokens = parsePatternList(pattern, call.line);
      const head = tokens[0]!;
      const rest = tokens.slice(1);
      const decision = parseDecision(args.get("decision"), call.line);
      const justificationRaw = args.get("justification");
      let justification: string | null = null;
      if (justificationRaw !== undefined) {
        justification = unquote(justificationRaw, call.line);
        if (justification.trim() === "") {
          throw new RulesParseError("justification cannot be empty", call.line);
        }
      }
      const heads = "alts" in head ? head.alts : [head.single];
      const specs: PrefixRuleSpec[] = heads.map((first) => ({ first, rest, decision, justification }));
      rules.push(...specs);
      const matchRaw = args.get("match");
      const notMatchRaw = args.get("not_match");
      if (matchRaw !== undefined || notMatchRaw !== undefined) {
        const parseExamples = (raw: string | undefined): string[][] => {
          if (raw === undefined) return [];
          const s = raw.trim();
          if (!s.startsWith("[") || !s.endsWith("]")) {
            throw new RulesParseError("match examples must be a list", call.line);
          }
          return splitArgs(s.slice(1, -1)).map((example) => {
            const t = example.trim();
            if (!t.startsWith("[") || !t.endsWith("]")) {
              throw new RulesParseError("an example must be an argv list", call.line);
            }
            return splitArgs(t.slice(1, -1)).map((e) => unquote(e, call.line));
          });
        };
        validations.push({ rules: specs, matches: parseExamples(matchRaw), notMatches: parseExamples(notMatchRaw) });
      }
      continue;
    }
    if (call.name === "network_rule" || call.name === "host_executable") {
      // Accepted for source compatibility; the gate consumes prefix rules
      // only (Rust runtime path: host_executables drive
      // resolve_host_executables lookups, which the gate never enables).
      continue;
    }
    throw new RulesParseError(`unknown policy builtin ${call.name}`, call.line);
  }
  return { rules, validations };
}
