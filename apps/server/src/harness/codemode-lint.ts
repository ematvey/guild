// Static check on codemode script source, run in the beforeTool hook before
// the sandbox starts. The observed failure modes are all fast to detect in
// the source text and all cheaper to teach at submit time than to let crash
// (or spin) at run time: timers and busy-wait sleeps (none exist in the
// sandbox — the model then burns the script timeout), sandbox globals
// misread as `tools.*` members, positional string arguments (every tool
// takes one object), and Node-isms (no Node, no network — nested tool calls
// do I/O). Pure function of the arguments: deterministic under replay.

import { parse } from "@babel/parser";
import { VISITOR_KEYS, type Node, type Statement, type ObjectExpression } from "@babel/types";
import { MAX_TOOL_CALLS_IN_FLIGHT } from "./tool-concurrency.js";

/** One lint rule: the regex (per line, so the report can point at it) and
 *  the teaching text for what to do instead. */
const RULES: readonly { pattern: RegExp; message: string }[] = [
  {
    pattern: /\b(setTimeout|setInterval|setImmediate|queueMicrotask)\s*\(/,
    message:
      'the sandbox has NO timers ("no Node, file system, network, or timers") — setTimeout/setInterval are not defined. There is no way to sleep or delay inside a script. Independent nested calls run together in one `Promise.all`; split long work across several codemode calls.',
  },
  {
    pattern: /while\s*\(\s*(Date\.now\(\)|performance\.now\(\))/,
    message:
      "busy-waiting on a clock does not work: the script holds the CPU and burns the script timeout with no effect. There is no way to sleep in the sandbox — batch independent calls with `Promise.all` instead.",
  },
  {
    pattern: /tools\.(searchTools|ALL_TOOLS|describeTool|describeNamespace|store|load|text|image|exit)\b/,
    message:
      'searchTools, ALL_TOOLS, describeTool, describeNamespace, store, load, text, image and exit are sandbox GLOBALS — call them bare (`await searchTools("query")`), never as tools.searchTools. Only the conversation\'s real tools live on `tools`.',
  },
  {
    pattern: /\btools\.[A-Za-z_$][\w$]*\s*\(\s*["']/,
    message:
      'tool arguments are always ONE object per the tool\'s declaration — never a positional string or number. Example: `await tools.bash({ command: "pwd" })`, not `tools.bash("pwd")`.',
  },
  {
    pattern: /\b(require\s*\(|process\.|Buffer\b|global\.|window\.|document\.|fetch\s*\()/,
    message:
      "the sandbox has no Node and no network: require, process, Buffer, window, document and fetch do not exist. All I/O goes through nested tool calls (`await tools.<name>(...)`) — e.g. web_fetch for URLs.",
  },
];

/** The first lint hit for a script source, as the block text the model
 *  sees (undefined: nothing wrong — or nothing checkable). */
export function codemodeScriptLint(
  code: string,
  isReadCall: (name: string, args: Record<string, unknown>) => boolean = () => false,
): string | undefined {
  for (const rule of RULES) {
    if (rule.pattern.test(code)) return `blocked by the codemode script check: ${rule.message}`;
  }
  return serialReadsLint(code, isReadCall);
}

/** Only a deliberately small, straight-line subset is proved independent.
 * Unknown syntax is left to the runtime, never rewritten or assumed safe. */
function serialReadsLint(code: string, isReadCall: (name: string, args: Record<string, unknown>) => boolean) {
  let program;
  try {
    program = parse(code, {
      sourceType: "script",
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
    }).program;
  } catch {
    return undefined;
  }
  const nodes = (node: Node): Node[] => {
    const fields = node as unknown as Record<string, unknown>;
    return (VISITOR_KEYS[node.type] ?? []).flatMap((key) => {
      const value = fields[key];
      return (Array.isArray(value) ? value : [value]).filter(
        (child): child is Node => child !== null && typeof child === "object" && typeof child.type === "string",
      );
    });
  };
  const contains = (node: Node, test: (value: Node) => boolean): boolean =>
    test(node) || nodes(node).some((child) => contains(child, test));
  const hostNames = new Set(["tools", "String", "Number", "Boolean", "JSON", "text"]);
  // A script may shadow a host capability or replace a method. Do not draw
  // conclusions from its names in that case.
  if (
    contains(
      program,
      (n) =>
        (n.type === "VariableDeclarator" && n.id.type === "Identifier" && hostNames.has(n.id.name)) ||
        (n.type === "FunctionDeclaration" && n.id != null && hostNames.has(n.id.name)) ||
        ((n.type === "FunctionDeclaration" ||
          n.type === "FunctionExpression" ||
          n.type === "ArrowFunctionExpression") &&
          n.params.some((p) => contains(p, (x) => x.type === "Identifier" && hostNames.has(x.name)))) ||
        n.type === "AssignmentExpression" ||
        n.type === "UpdateExpression" ||
        n.type === "WithStatement",
    )
  )
    return undefined;

  const keyOf = (node: Node): string | undefined =>
    node.type === "Identifier" ? node.name : node.type === "StringLiteral" ? node.value : undefined;
  const member = (node: Node): string | undefined =>
    node.type === "MemberExpression" && (!node.computed || node.property.type === "StringLiteral")
      ? keyOf(node.property)
      : undefined;
  const literal = (node: Node | undefined): unknown => {
    if (node?.type === "StringLiteral" || node?.type === "NumericLiteral" || node?.type === "BooleanLiteral")
      return node.value;
    if (node?.type === "TemplateLiteral" && node.expressions.length === 0) return node.quasis[0]?.value.cooked;
    return undefined;
  };
  const argumentsOf = (node: ObjectExpression): Record<string, unknown> | undefined => {
    const args: Record<string, unknown> = {};
    for (const property of node.properties) {
      if (property.type !== "ObjectProperty" || property.computed) return undefined;
      const key = keyOf(property.key);
      if (key === undefined) return undefined;
      args[key] = literal(property.value);
    }
    return args;
  };
  // Transformations of a tool's string result, plus literals and local
  // values, including simple expression-only map callbacks. No arbitrary
  // helpers, getters, mutation, object spreads, or calls chosen dynamically.
  const pure = (node: Node, names: ReadonlySet<string>): boolean => {
    switch (node.type) {
      case "StringLiteral":
      case "NumericLiteral":
      case "BooleanLiteral":
      case "NullLiteral":
      case "RegExpLiteral":
        return true;
      case "Identifier":
        return names.has(node.name) || node.name === "undefined";
      case "TemplateLiteral":
        return node.expressions.every((x) => pure(x, names));
      case "BinaryExpression":
      case "LogicalExpression":
        return pure(node.left, names) && pure(node.right, names);
      case "UnaryExpression":
        return node.operator !== "delete" && pure(node.argument, names);
      case "ConditionalExpression":
        return pure(node.test, names) && pure(node.consequent, names) && pure(node.alternate, names);
      case "ArrayExpression":
        return node.elements.every((x) => x === null || pure(x, names));
      case "SpreadElement":
        return pure(node.argument, names);
      case "ArrowFunctionExpression": {
        if (node.async || !node.params.every((p) => p.type === "Identifier") || node.body.type === "BlockStatement")
          return false;
        const local = new Set(names);
        for (const parameter of node.params) if (parameter.type === "Identifier") local.add(parameter.name);
        return pure(node.body, local);
      }
      case "ObjectExpression":
        return node.properties.every((x) => x.type === "ObjectProperty" && !x.computed && pure(x.value, names));
      case "MemberExpression":
        return pure(node.object, names) && (!node.computed || pure(node.property, names));
      case "CallExpression": {
        if (!node.arguments.every((x) => pure(x, names))) return false;
        if (node.callee.type === "Identifier") return ["String", "Number", "Boolean"].includes(node.callee.name);
        if (node.callee.type !== "MemberExpression") return false;
        if (node.callee.object.type === "Identifier" && node.callee.object.name === "JSON")
          return ["parse", "stringify"].includes(member(node.callee) ?? "");
        return (
          ["match", "matchAll", "map", "slice", "substring", "trim", "toLowerCase", "toUpperCase", "join"].includes(
            member(node.callee) ?? "",
          ) && pure(node.callee.object, names)
        );
      }
      default:
        return false;
    }
  };

  const helpers = new Map<string, { parameter: string; tool: string }>();
  const toolOf = (node: Node): string | undefined =>
    node.type === "CallExpression" &&
    node.callee.type === "MemberExpression" &&
    node.callee.object.type === "Identifier" &&
    node.callee.object.name === "tools"
      ? member(node.callee)
      : undefined;
  // Recognize a transparent async wrapper, optionally String(...) and a
  // try/catch that only turns an error into text. Nothing else executes.
  for (const statement of program.body) {
    if (
      statement.type !== "FunctionDeclaration" ||
      !statement.async ||
      !statement.id ||
      statement.params.length !== 1 ||
      statement.params[0].type !== "Identifier"
    )
      continue;
    const parameter = statement.params[0].name;
    let body = statement.body.body;
    if (body.length === 1 && body[0].type === "TryStatement") {
      const attempt = body[0];
      const handler = attempt.handler;
      if (attempt.finalizer || !handler || handler.param?.type !== "Identifier" || handler.body.body.length !== 1)
        continue;
      const fallback = handler.body.body[0];
      if (
        fallback.type !== "ReturnStatement" ||
        !fallback.argument ||
        !pure(fallback.argument, new Set([handler.param.name]))
      )
        continue;
      body = attempt.block.body;
    }
    if (body.length !== 1 || body[0].type !== "ReturnStatement" || !body[0].argument) continue;
    let result: Node = body[0].argument;
    if (
      result.type === "CallExpression" &&
      result.callee.type === "Identifier" &&
      result.callee.name === "String" &&
      result.arguments.length === 1
    )
      result = result.arguments[0];
    if (result.type !== "AwaitExpression" || result.argument.type !== "CallExpression") continue;
    const call = result.argument;
    const tool = toolOf(call);
    if (
      tool &&
      call.arguments.length === 1 &&
      call.arguments[0].type === "Identifier" &&
      call.arguments[0].name === parameter
    )
      helpers.set(statement.id.name, { parameter, tool });
  }

  // A local binding may shadow a helper even though tools itself is not
  // shadowed. Such a script is outside this proof's lexical subset.
  if (
    contains(
      program,
      (n) =>
        (n.type === "VariableDeclarator" && n.id.type === "Identifier" && helpers.has(n.id.name)) ||
        ((n.type === "FunctionDeclaration" ||
          n.type === "FunctionExpression" ||
          n.type === "ArrowFunctionExpression") &&
          n.params.some((p) => contains(p, (x) => x.type === "Identifier" && helpers.has(x.name)))),
    )
  )
    return undefined;

  const read = (node: Node, names: ReadonlySet<string>): boolean => {
    if (node.type !== "AwaitExpression" || node.argument.type !== "CallExpression") return false;
    const call = node.argument;
    const tool = toolOf(call) ?? (call.callee.type === "Identifier" ? helpers.get(call.callee.name)?.tool : undefined);
    const arg = call.arguments[0];
    if (!tool || call.arguments.length !== 1 || arg?.type !== "ObjectExpression" || !pure(arg, names)) return false;
    const args = argumentsOf(arg);
    return args !== undefined && isReadCall(tool, args);
  };
  const hint = (node: Node): string =>
    `blocked by the codemode script check: independent read calls at line ${node.loc?.start.line ?? 1} run sequentially. ` +
    "Submit them with `await Promise.all(items.map(async (item) => { ... }))`; collect results in input order. " +
    `At most ${MAX_TOOL_CALLS_IN_FLIGHT} tool calls execute concurrently. Keep pagination and calls that depend on earlier results or side effects sequential.`;

  const names = new Set<string>();
  const collectors = new Set<string>();
  const sizes = new Map<string, number>();
  let consecutive: Statement[] = [];
  let produced = new Set<string>();
  for (const statement of program.body) {
    if (statement.type === "FunctionDeclaration") continue;
    const declaration =
      statement.type === "VariableDeclaration" && statement.declarations.length === 1
        ? statement.declarations[0]
        : undefined;
    const expression =
      declaration?.init ?? (statement.type === "ExpressionStatement" ? statement.expression : undefined);
    // Adjacent reads qualify only when no call consumes the preceding
    // reads' results. The minimum avoids a correction round for tiny pairs.
    if (
      expression &&
      read(expression, names) &&
      !contains(expression, (n) => n.type === "Identifier" && produced.has(n.name))
    ) {
      consecutive.push(statement);
      if (declaration?.id.type === "Identifier") produced.add(declaration.id.name);
      if (consecutive.length >= 4) return hint(consecutive[0]);
    } else {
      consecutive = [];
      produced = new Set();
    }
    if (
      statement.type === "ForOfStatement" &&
      !statement.await &&
      statement.left.type === "VariableDeclaration" &&
      statement.left.kind === "const" &&
      statement.left.declarations.length === 1 &&
      statement.left.declarations[0].id.type === "Identifier"
    ) {
      const iterable = statement.right;
      const items = iterable.type === "ArrayExpression" ? iterable : undefined;
      const stable =
        (iterable.type === "Identifier" && names.has(iterable.name)) || (items !== undefined && pure(items, names));
      const body = statement.body.type === "BlockStatement" ? statement.body.body : [statement.body];
      const local = new Set(names);
      local.add(statement.left.declarations[0].id.name);
      let reads = 0;
      const size = items?.elements.length ?? (iterable.type === "Identifier" ? sizes.get(iterable.name) : undefined);
      let safe = stable && !collectors.has(statement.left.declarations[0].id.name) && (size === undefined || size >= 4);
      for (const entry of body) {
        if (entry.type === "VariableDeclaration") {
          for (const variable of entry.declarations) {
            if (
              variable.id.type !== "Identifier" ||
              !variable.init ||
              local.has(variable.id.name) ||
              collectors.has(variable.id.name)
            ) {
              safe = false;
              break;
            }
            if (read(variable.init, local)) reads++;
            else if (!pure(variable.init, local)) {
              safe = false;
              break;
            }
            local.add(variable.id.name);
          }
        } else if (entry.type === "ExpressionStatement") {
          const value = entry.expression;
          if (read(value, local)) reads++;
          else if (
            value.type === "CallExpression" &&
            value.arguments.every((x) => pure(x, local)) &&
            ((value.callee.type === "Identifier" && value.callee.name === "text") ||
              (value.callee.type === "MemberExpression" &&
                value.callee.object.type === "Identifier" &&
                collectors.has(value.callee.object.name) &&
                member(value.callee) === "push"))
          ) {
            /* Output only; never feeds another call. */
          } else safe = false;
        } else safe = false;
      }
      if (safe && reads > 0) return hint(statement);
    }
    if (statement.type === "VariableDeclaration" && statement.kind === "const") {
      for (const variable of statement.declarations) {
        if (variable.id.type !== "Identifier" || !variable.init) continue;
        if (
          variable.init.type === "ArrayExpression" &&
          !variable.init.elements.some((x) => x?.type === "SpreadElement")
        )
          sizes.set(variable.id.name, variable.init.elements.length);
        if (variable.init.type === "ArrayExpression" && variable.init.elements.length === 0)
          collectors.add(variable.id.name);
        else if (contains(variable.init, (n) => n.type === "Identifier" && collectors.has(n.name)))
          collectors.add(variable.id.name);
        else if (pure(variable.init, names) || read(variable.init, names)) names.add(variable.id.name);
      }
    }
  }
  return undefined;
}
