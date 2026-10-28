// The renderer is the last write boundary before the wire. These tests pin
// the fields that the schema declares but a hand-written switch can drop.

import { describe, expect, it } from "vitest";
import type { ThreadEvent } from "@guild/wire/rest";
import {
  assistantMessageEvent,
  normalizeThreadEvent,
  threadEventObject,
} from "../platform/domain/thread-events.js";

describe("thread event wire", () => {
  it("carries the approval judge verdict when it exists", () => {
    const event: ThreadEvent = {
      type: "approval_request",
      call_id: "call-1",
      name: "execute",
      arguments: "{}",
      judge: { approve: false, reason: "destructive", ms: 850 },
    };
    expect(threadEventObject(event)).toMatchObject({
      judge: { approve: false, reason: "destructive", ms: 850 },
    });
  });

  it("omits the judge field when the judge did not run", () => {
    const event: ThreadEvent = {
      type: "approval_request",
      call_id: "call-1",
      name: "execute",
      arguments: "{}",
    };
    expect(threadEventObject(event)).not.toHaveProperty("judge");
  });

  it("keeps usage present on an assistant message", () => {
    const event = {
      type: "assistant_message",
      turn: 1,
      step: 0,
      blocks: [],
      usage: undefined,
      model: "gpt-5",
    } as unknown as ThreadEvent;
    expect(threadEventObject(event)).toHaveProperty("usage", {});
  });

  it("keeps the judge verdict when a persisted row is normalized", () => {    const event = normalizeThreadEvent({
      type: "approval_request",
      call_id: "call-1",
      name: "execute",
      arguments: "{}",
      judge: { approve: true, reason: "safe", ms: 12 },
    });
    expect(event).toMatchObject({ judge: { approve: true, reason: "safe", ms: 12 } });
  });

  it("carries the turn's attached files on the assistant message", () => {
    const attachments = [
      { id: "att-1", filename: "build.html", content_type: "text/html", size_bytes: 13, modality: "document" },
    ];
    const event = assistantMessageEvent(1, 1, [{ type: "text", text: "done" }], {}, "m", undefined, undefined, attachments);
    expect(threadEventObject(event)).toMatchObject({ attachments });
    expect(normalizeThreadEvent(threadEventObject(event) as unknown as Record<string, unknown>)).toMatchObject({
      attachments,
    });
  });

  it("omits the attachments field when the turn attached nothing", () => {
    const event = assistantMessageEvent(1, 1, [{ type: "text", text: "done" }], {}, "m");
    expect(threadEventObject(event)).not.toHaveProperty("attachments");
  });
});
