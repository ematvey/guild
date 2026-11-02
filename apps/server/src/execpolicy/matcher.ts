// Exec-policy gate (the prefix matcher): a matched `allow` rule skips the
// approval gate entirely; a matched `deny` rule is a hard deny whose
// text is the rule's justification; `prompt` rules and unmatched commands
// fall through to the chat's approval flow. Rules are static assets — the
// decision is a pure function of (rules, command).

import {
  parseRulesFile,
  type DecisionKind,
  type PatternToken,
  type PrefixRuleSpec,
  type RuleMatchExample,
} from "./rule-parser.js";
import { readFileSync } from "node:fs";
import path from "node:path";

export type ExecPolicyDecision = { kind: "allow" } | { kind: "deny"; reason: string } | { kind: "prompt" };

// Decision ordering: allow < prompt < deny.
const DECISION_RANK: Record<DecisionKind, number> = { allow: 0, prompt: 1, deny: 2 };

interface PrefixRule {
  first: string;
  rest: PatternToken[];
  decision: DecisionKind;
  justification: string | null;
}

export class ExecPolicy {
  private readonly rulesByProgram = new Map<string, PrefixRule[]>();

  private constructor(rules: PrefixRule[]) {
    for (const rule of rules) {
      const list = this.rulesByProgram.get(rule.first);
      if (list) list.push(rule);
      else this.rulesByProgram.set(rule.first, [rule]);
    }
  }

  static empty(): ExecPolicy {
    return new ExecPolicy([]);
  }

  /** Builds from parsed rule specs. */
  static fromSpecs(specs: PrefixRuleSpec[]): ExecPolicy {
    return new ExecPolicy(specs.map((s) => ({ ...s })));
  }

  private patternMatches(rule: PrefixRule, cmd: string[]): number | null {
    // PrefixPattern::matches_prefix: the command must be at least as long as
    // the pattern and every pattern token must match.
    const patternLength = rule.rest.length + 1;
    if (cmd.length < patternLength || cmd[0] !== rule.first) return null;
    for (let i = 1; i < patternLength; i++) {
      const token = rule.rest[i - 1]!;
      const actual = cmd[i]!;
      const matched = "single" in token ? token.single === actual : token.alts.includes(actual);
      if (!matched) return null;
    }
    return patternLength;
  }

  /** `Policy::check_multiple`: every segment is matched; unmatched segments
   *  fall back to the heuristics decision (Prompt); the aggregate decision
   *  is the strictest match (max by Decision ordering). */
  checkMultiple(
    commands: string[][],
    heuristicsDecision: DecisionKind = "prompt",
  ): { decision: DecisionKind; matched: { first: string; decision: DecisionKind; justification: string | null }[] } {
    const matched: { first: string; decision: DecisionKind; justification: string | null }[] = [];
    for (const cmd of commands) {
      const rules = cmd.length > 0 ? (this.rulesByProgram.get(cmd[0]!) ?? []) : [];
      const hits = rules
        .map((rule) => ({ rule, len: this.patternMatches(rule, cmd) }))
        .filter((h): h is { rule: PrefixRule; len: number } => h.len !== null)
        .map((h) => ({ first: h.rule.first, decision: h.rule.decision, justification: h.rule.justification }));
      if (hits.length > 0) matched.push(...hits);
      else matched.push({ first: cmd[0] ?? "", decision: heuristicsDecision, justification: null });
    }
    let decision: DecisionKind = "allow";
    for (const m of matched) {
      if (DECISION_RANK[m.decision] > DECISION_RANK[decision]) decision = m.decision;
    }
    return { decision, matched };
  }
}

// ---------------------------------------------------------------------------
// Tokenization: POSIX shlex-style word splitting with single and double
// quotes and backslash escapes. An unterminated quote returns null, and the
// gate prompts.
// ---------------------------------------------------------------------------

export function shlexSplit(line: string): string[] | null {
  const tokens: string[] = [];
  let current = "";
  let sawAny = false;
  let i = 0;
  while (i < line.length) {
    const c = line[i]!;
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      if (sawAny) {
        tokens.push(current);
        current = "";
        sawAny = false;
      }
      i += 1;
      continue;
    }
    sawAny = true;
    if (c === "'") {
      let closed = false;
      i += 1;
      while (i < line.length) {
        if (line[i] === "'") {
          closed = true;
          i += 1;
          break;
        }
        current += line[i]!;
        i += 1;
      }
      if (!closed) return null;
      continue;
    }
    if (c === '"') {
      let closed = false;
      i += 1;
      while (i < line.length) {
        const ch = line[i]!;
        if (ch === '"') {
          closed = true;
          i += 1;
          break;
        }
        if (ch === "\\") {
          const next = line[i + 1];
          i += 2;
          // Inside double quotes a backslash escapes only $ ` " \ newline.
          if (next !== undefined && [`$`, "`", '"', "\\", "\n"].includes(next)) {
            current += next === "\n" ? "" : next;
          } else {
            current += "\\";
            if (next !== undefined) current += next;
          }
          continue;
        }
        current += ch;
        i += 1;
      }
      if (!closed) return null;
      continue;
    }
    if (c === "\\") {
      const next = line[i + 1];
      if (next === undefined) return null; // trailing backslash: unterminated
      current += next;
      i += 2;
      continue;
    }
    // shlex treats most punctuation as ordinary word characters; operators
    // glue onto words (the gate splits them back out).
    current += c;
    i += 1;
  }
  if (sawAny) tokens.push(current);
  return tokens;
}

/** Control operators shlex leaves glued to words (`date&&rm`): split them
 *  out so segmentation sees every command. `;` and `|` are NOT split — they
 *  stay suspect tokens and force a Prompt. Quoted arguments that contain
 *  these characters split apart too, which only ever widens the analysis. */
function splitGluedOperators(tokens: string[]): string[] {
  const out: string[] = [];
  for (const token of tokens) {
    let current = "";
    let i = 0;
    while (i < token.length) {
      const c = token[i]!;
      const next = token[i + 1];
      let sep: string | null = null;
      if (c === "&" && next === "&") {
        sep = "&&";
        i += 2;
      } else if (c === "|" && next === "|") {
        sep = "||";
        i += 2;
      } else if (c === "&") {
        sep = "&";
        i += 1;
      } else {
        current += c;
        i += 1;
        continue;
      }
      if (current !== "") {
        out.push(current);
        current = "";
      }
      out.push(sep);
    }
    if (current !== "") out.push(current);
  }
  return out;
}

/** Splits the token stream at shell control operators — each segment is
 *  evaluated independently (codex command segmentation). */
function splitSegments(tokens: string[]): string[][] {
  const segments: string[][] = [[]];
  for (const token of tokens) {
    if (token === "&&" || token === "||" || token === ";" || token === "|" || token === "&") {
      segments.push([]);
    } else {
      segments[segments.length - 1]!.push(token);
    }
  }
  return segments.filter((s) => s.length > 0);
}

const CONTROL_OPERATORS = new Set(["&&", "||", ";", "|", "&"]);

function isControlOperatorToken(token: string): boolean {
  return CONTROL_OPERATORS.has(token);
}

/** True when a token carries shell syntax the prefix rules cannot see. */
function tokenCarriesShellMeta(token: string): boolean {
  return (
    token.includes("`") ||
    token.includes("$(") ||
    token.includes(">") ||
    token.includes("<") ||
    token.includes(";") ||
    token.includes("|") ||
    token.includes("&")
  );
}

/** Prefix matches cannot distinguish inspection from flags that write state
 *  or invoke external programs — those variants drop to the approval gate. */
function readonlyCommandHasEffects(argv: string[]): boolean {
  const first = argv[0];
  switch (first) {
    case "hostname":
      return argv.length > 1;
    case "date":
      return argv.slice(1).some((arg) => {
        if (arg.startsWith("--s")) return true;
        if (arg.startsWith("-") && !arg.startsWith("--") && arg.slice(1).includes("s")) return true;
        // An operand (neither flag nor `+format`) is a settime spec.
        return !arg.startsWith("-") && !arg.startsWith("+");
      });
    case "git":
      if (argv[1] === "diff" || argv[1] === "log" || argv[1] === "show") {
        return argv.slice(2).some((arg) => arg.startsWith("--output") || arg === "--ext-diff" || arg === "--textconv");
      }
      // Git parses flags ahead of the subcommand: after `remote -v`, only
      // further flags are inspection; a non-flag token (or `--`) is a
      // subcommand that rewrites remotes.
      if (argv[1] === "remote") {
        const idx = argv.slice(2).findIndex((arg) => arg === "-v" || arg === "--verbose");
        if (idx === -1) return false;
        return argv.slice(2 + idx + 1).some((arg) => arg === "--" || !arg.startsWith("-"));
      }
      return false;
    default:
      return false;
  }
}

function evaluateLine(policy: ExecPolicy, line: string): ExecPolicyDecision {
  const tokens = shlexSplit(line);
  if (tokens === null) return { kind: "prompt" };
  const split = splitGluedOperators(tokens);
  const segments = splitSegments(split);
  if (segments.length === 0) return { kind: "prompt" };
  const { decision, matched } = policy.checkMultiple(segments);
  if (decision === "deny") {
    const justification = matched.find((m) => m.decision === "deny" && m.justification !== null)?.justification;
    return { kind: "deny", reason: justification ?? "denied by exec policy" };
  }
  // A static Allow is only safe when no segment carries effects and no token
  // carries shell meta the prefix rules cannot see. Prompt and Deny verdicts
  // never auto-run, so they need no demotion.
  if (decision === "allow") {
    const hasEffects = segments.some((segment) => readonlyCommandHasEffects(segment));
    const hasMeta = split.some((t) => !isControlOperatorToken(t) && tokenCarriesShellMeta(t));
    if (hasEffects || hasMeta) return { kind: "prompt" };
  }
  return { kind: decision };
}

/** Evaluates one `execute`/`bash` command string against the static policy.
 *  `sh -c` runs the whole string: a newline is a command separator the
 *  tokenizer never sees, so every line is evaluated on its own and the
 *  strictest verdict wins (Deny > Prompt > Allow). */
export function evaluateCommand(policy: ExecPolicy, command: string): ExecPolicyDecision {
  let sawLine = false;
  let allAllow = true;
  let deny: string | null = null;
  for (const line of command.split("\n")) {
    if (line.trim() === "") continue;
    sawLine = true;
    const verdict = evaluateLine(policy, line);
    if (verdict.kind === "allow") continue;
    allAllow = false;
    if (verdict.kind === "deny" && deny === null) deny = verdict.reason;
  }
  if (!sawLine) return { kind: "prompt" };
  if (deny !== null) return { kind: "deny", reason: deny };
  if (allAllow) return { kind: "allow" };
  return { kind: "prompt" };
}

/** Evaluates the machine `execute` tool arguments against the static policy
 *. */
export function evaluateExecute(policy: ExecPolicy, args: unknown): ExecPolicyDecision {
  const command =
    typeof args === "object" && args !== null && "command" in args
      ? (args as { command?: unknown }).command
      : undefined;
  if (typeof command !== "string") return { kind: "prompt" };
  return evaluateCommand(policy, command);
}

// ---------------------------------------------------------------------------
// Static loading: base rules + optional deployment-local
// layer; a broken local layer degrades to base-only with a warning.
// ---------------------------------------------------------------------------

function validateExamples(validations: RuleMatchExample[], source: string): void {
  // Each match / not_match example runs against a policy built from its own
  // file's rules only.
  for (const v of validations) {
    const scoped = ExecPolicy.fromSpecs(v.rules);
    for (const example of v.matches) {
      const { matched } = scoped.checkMultiple([example], "prompt");
      const nonHeuristic = matched.some((m) => m.decision !== "prompt");
      if (!nonHeuristic) {
        throw new Error(`${source}: rule match example did not match: ${example.join(" ")}`);
      }
    }
    for (const example of v.notMatches) {
      const { matched } = scoped.checkMultiple([example], "prompt");
      const nonHeuristic = matched.some((m) => m.decision !== "prompt");
      if (nonHeuristic) {
        throw new Error(`${source}: rule not_match example matched: ${example.join(" ")}`);
      }
    }
  }
}

/** The default rules location, apps/server/assets, resolved from the
 *  working directory (dev and container both run with cwd = apps/server). */
export function defaultRulesPath(): string {
  return process.env.GUILD_EXEC_POLICY_RULES ?? path.resolve(process.cwd(), "assets/exec_policy_base.rules");
}

const cached = new Map<string, ExecPolicy>();

/** The policy for one base rules file (base + optional local layer),
 *  loaded once per path. Missing or unparsable base rules are a startup
 *  error; a broken local layer degrades to base-only. */
export function execPolicy(rulesPath: string = defaultRulesPath()): ExecPolicy {
  const hit = cached.get(rulesPath);
  if (hit !== undefined) return hit;
  const baseSrc = readFileSync(rulesPath, "utf8");
  const base = parseRulesFile(baseSrc);
  const rules = [...base.rules];
  const validations = [...base.validations];
  const localPath = path.join(path.dirname(rulesPath), "exec_policy_local.rules");
  try {
    const localSrc = readFileSync(localPath, "utf8");
    const local = parseRulesFile(localSrc);
    rules.push(...local.rules);
    validations.push(...local.validations);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      if ((error as NodeJS.ErrnoException).code === undefined) {
        // A parse error in the local layer: degrade to base-only (never a
        // startup failure).
        console.warn(`local exec policy rules do not parse, using base rules only: ${String(error)}`);
      } else {
        throw error;
      }
    }
  }
  const policy = ExecPolicy.fromSpecs(rules);
  validateExamples(validations, rulesPath);
  cached.set(rulesPath, policy);
  return policy;
}

/** Test seam: resets the process-wide cache. */
export function resetExecPolicyCache(): void {
  cached.clear();
}
