// Post-run timing heuristic. Durations alone cannot establish overlap or
// independence, so the hint is conditional and preserves ordered effects.

import type { ToolExecutionResult } from "@earendil-works/pi-durable";

/** Below this many calls a serial chain costs little. */
const MIN_CALLS = 4;
/** Below this much tool time the chain is not worth a hint. */
const MIN_TOOL_MS = 2_000;
/** Tool time over wall time screens possible batching opportunities, not
 * proof of serial execution: uneven parallel calls can also qualify. */
const SERIAL_MIN_SHARE = 0.3;
const SERIAL_MAX_SHARE = 1.15;

/** One nested call as the codemode result lists it. */
export interface NestedCallTiming {
  readonly durationMs?: number;
}

/** Conditional advice for a qualifying batch, without asserting overlap. */
export function serialCallsHint(calls: readonly NestedCallTiming[], wallMs: number): string | undefined {
  if (calls.length < MIN_CALLS || wallMs <= 0) return undefined;
  let total = 0;
  for (const call of calls) total += call.durationMs ?? 0;
  const share = total / wallMs;
  if (total < MIN_TOOL_MS || share < SERIAL_MIN_SHARE || share > SERIAL_MAX_SHARE) return undefined;
  return (
    `[codemode] ${calls.length} tool calls used ${seconds(total)} combined in ${seconds(wallMs)} wall time. ` +
    "If independent reads ran sequentially, batch them with `await Promise.all(items.map((item) => tools.x({ item })))`. " +
    "Preserve ordering when calls depend on earlier results or side effects, including writes followed by reads."
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
