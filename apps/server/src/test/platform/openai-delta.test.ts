import { describe, expect, it } from "vitest";
import { parseOpenAiFrame } from "../../platform/provider/openai.js";

describe("parseOpenAiFrame: reasoning delta dialects", () => {
  it("reads reasoning_content", () => {
    const frame = parseOpenAiFrame('{"choices":[{"delta":{"reasoning_content":"think"}}]}');
    expect(frame.chunks).toEqual([
      { kind: "thinking", textDelta: "think", tokensIn: undefined, tokensOut: undefined, reasoningTokens: undefined },
    ]);
  });

  it("reads vLLM's reasoning field", () => {
    const frame = parseOpenAiFrame('{"choices":[{"delta":{"reasoning":"think"}}]}');
    expect(frame.chunks).toEqual([
      { kind: "thinking", textDelta: "think", tokensIn: undefined, tokensOut: undefined, reasoningTokens: undefined },
    ]);
  });

  it("keeps reasoning and content in one delta as separate chunks", () => {
    const frame = parseOpenAiFrame('{"choices":[{"delta":{"reasoning":"think","content":"answer"}}]}');
    expect(frame.chunks.map((c) => c.kind)).toEqual(["thinking", "text"]);
  });
});
