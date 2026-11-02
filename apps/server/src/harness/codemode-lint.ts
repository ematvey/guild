// Static check on codemode script source, run in the beforeTool hook before
// the sandbox starts. The observed failure modes are all fast to detect in
// the source text and all cheaper to teach at submit time than to let crash
// (or spin) at run time: timers and busy-wait sleeps (none exist in the
// sandbox — the model then burns the script timeout), sandbox globals
// misread as `tools.*` members, positional string arguments (every tool
// takes one object), and Node-isms (no Node, no network — nested tool calls
// do I/O). Pure function of the arguments: deterministic under replay.

/** One lint rule: the regex (per line, so the report can point at it) and
 *  the teaching text for what to do instead. */
const RULES: readonly { pattern: RegExp; message: string }[] = [
  {
    pattern: /\b(setTimeout|setInterval|setImmediate|queueMicrotask)\s*\(/,
    message:
      'the sandbox has NO timers ("no Node, file system, network, or timers") — setTimeout/setInterval are not defined. There is no way to sleep or delay inside a script. Pace calls with sequential awaits (each nested call takes real time) and split long work across several codemode calls.',
  },
  {
    pattern: /while\s*\(\s*(Date\.now\(\)|performance\.now\(\))/,
    message:
      "busy-waiting on a clock does not work: the script holds the CPU and burns the script timeout with no effect. There is no way to sleep in the sandbox — use sequential awaits instead.",
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
export function codemodeScriptLint(code: string): string | undefined {
  for (const rule of RULES) {
    if (rule.pattern.test(code)) return `blocked by the codemode script check: ${rule.message}`;
  }
  return undefined;
}
