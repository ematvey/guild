import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, createRegistry, InboxDoc, LiveDoc, MemoryStorage, type Conversation, type Harness as AgentHarness } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { drainIdleInbox } from "../harness/queue-recovery.js";
let harness: AgentHarness;
afterEach(async () => { await harness?.close(BACKGROUND_CONTEXT); });
async function setup(): Promise<Conversation> {
  harness = await Harness.open(new MemoryStorage(), { models: createModels(), registry: createRegistry() }, BACKGROUND_CONTEXT);
  return harness.createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
}
async function queued(conversation: Conversation, mode: "steer" | "followUp", text: string) {
  return conversation.commit(async tx => {
    const inbox = await tx.doc(InboxDoc, conversation.id);
    const submission = await tx.createSubmission({ conversationId: conversation.id, type: "input", status: "queued" });
    inbox.items.push({ id: submission.id, mode, content: text });
    return submission.id;
  }, BACKGROUND_CONTEXT);
}
describe("idle inbox boundary", () => {
  it("places existing submissions once and preserves one-at-a-time queue order", async () => {
    const c = await setup();
    const first = await queued(c, "followUp", "first");
    const second = await queued(c, "followUp", "second");
    expect(await drainIdleInbox(c)).toBe(true);
    expect(await drainIdleInbox(c)).toBe(false);
    const state = await c.commit(async tx => ({ inputs: (await tx.doc(LiveDoc, c.id)).run?.inputs.slice(), queued: (await tx.doc(InboxDoc, c.id)).items.map(item => item.id) }), BACKGROUND_CONTEXT);
    expect(state.inputs).toEqual([first]);
    expect(state.queued).toEqual([second]);
    expect(await (await harness.submission(first, BACKGROUND_CONTEXT))!.status(BACKGROUND_CONTEXT)).toMatchObject({ status: "placed" });
  });
  it("places one steer and one follow-up in admission order", async () => {
    const c = await setup();
    const follow = await queued(c, "followUp", "first");
    const steer = await queued(c, "steer", "second");
    await queued(c, "steer", "third");
    await drainIdleInbox(c);
    const inputs = await c.commit(async tx => (await tx.doc(LiveDoc, c.id)).run?.inputs.slice(), BACKGROUND_CONTEXT);
    expect(inputs).toEqual([follow, steer]);
  });
  it("places queued context writes without creating a synthetic input or run", async () => {
    const c = await setup();
    const id = await c.commit(async tx => {
      const inbox = await tx.doc(InboxDoc, c.id);
      const submission = await tx.createSubmission({ conversationId: c.id, type: "write", status: "queued" });
      inbox.items.push({ id: submission.id, mode: "write", entry: { kind: "fixture.context", model: [] } });
      return submission.id;
    }, BACKGROUND_CONTEXT);
    expect(await drainIdleInbox(c)).toBe(false);
    expect(await (await harness.submission(id, BACKGROUND_CONTEXT))!.status(BACKGROUND_CONTEXT)).toMatchObject({ status: "done" });
    const entries = await c.entries({}, 10, undefined, BACKGROUND_CONTEXT);
    expect(entries.items.map(entry => entry.kind)).toEqual(["fixture.context"]);
  });
  it("settles a queued stale context write instead of reviving an obsolete head", async () => {
    const c = await setup();
    const id = await c.commit(async tx => {
      const inbox = await tx.doc(InboxDoc, c.id);
      await tx.appendEntry(c.id, { kind: "fixture.reset", head: "self" });
      const submission = await tx.createSubmission({ conversationId: c.id, type: "write", status: "queued" });
      inbox.items.push({ id: submission.id, mode: "write", entry: { kind: "fixture.old", head: 1 } });
      return submission.id;
    }, BACKGROUND_CONTEXT);
    await drainIdleInbox(c);
    expect(await (await harness.submission(id, BACKGROUND_CONTEXT))!.status(BACKGROUND_CONTEXT)).toMatchObject({ status: "unanswered", reason: "stale" });
  });
});
