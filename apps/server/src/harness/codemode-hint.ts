// Post-run hint on a codemode result: a script that made its tool calls one
// after another gets one line saying that independent calls run together.
// A hint, not a block: a chain whose next call needs the last result is
// correct, and the harness cannot prove independence from the source. The
// runtime launches nested calls concurrently, so the model only has to write
// them that way.

import type { ToolExecutionResult } from "@earendil-works/pi-durable";

/** Below this many calls a serial chain costs little. */
const MIN_CALLS = 4;
/** Below this much tool time the chain is not worth a hint. */
const MIN_TOOL_MS = 2_000;
/** Tool time over wall time. A serial chain sits just under 1; calls that
 *  overlap push it above, and the script's own work pushes it below. */
const SERIAL_MIN_SHARE = 0.7;
const SERIAL_MAX_SHARE = 1.15;

/** One nested call as the codemode result lists it. */
export interface NestedCallTiming {
  readonly durationMs?: number;
}

/** The hint for a script's calls, or undefined when they did not run serially. */
export function serialCallsHint(calls: readonly NestedCallTiming[], wallMs: number): string | undefined {
  if (calls.length < MIN_CALLS || wallMs <= 0) return undefined;
  let total = 0;
  for (const call of calls) total += call.durationMs ?? 0;
  const share = total / wallMs;
  if (total < MIN_TOOL_MS || share < SERIAL_MIN_SHARE || share > SERIAL_MAX_SHARE) return undefined;
  return (
    `[codemode] ${calls.length} tool calls ran one after another ` +
    `(${seconds(total)} of ${seconds(wallMs)}). Independent calls run together: ` +
    "`await Promise.all(items.map((item) => tools.x(item)))`. Keep a call sequential only when it needs the last result."
  );
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** The result with the hint appended to the text the model reads. */
export function withSerialCallsHint(result: ToolExecutionResult, wallMs: number): ToolExecutionResult {
  const details = result.details as { calls?: readonly NestedCallTiming[] } | undefined;
  const hint = serialCallsHint(details?.calls ?? [], wallMs);
  if (hint === undefined) return result;
  const output = result.output ?? [];
  return { ...result, output: [...output, { type: "text", text: hint }] };
}
