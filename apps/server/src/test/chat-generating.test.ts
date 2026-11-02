import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChatStore } from "../platform/store/chats.js";
import { createAgentsTestEnv } from "./agents/harness.js";

const env = await createAgentsTestEnv();

describe.skipIf(env === null)("chat generating flag", () => {
  let chats: ChatStore;
  let orgId: string;
  let userId: string;

  beforeAll(async () => {
    chats = new ChatStore(env!.db);
    orgId = randomUUID();
    userId = randomUUID();
    await env!.db.query("INSERT INTO orgs (id, name) VALUES ($1, 'generating-org')", [orgId]);
    await env!.db.query(
      `INSERT INTO users (id, org_id, email, password_hash, role, identity_type)
       VALUES ($1, $2, 'generating@example.test', '', 'member', 'managed')`,
      [userId, orgId],
    );
  }, 60_000);

  afterAll(async () => {
    await env?.cleanup();
  });

  it("reserveGenerating lets exactly one of two concurrent arrivals start", async () => {
    const chat = await chats.createChat(orgId, userId, "race", null);
    const priors = await Promise.all([
      chats.reserveGenerating(orgId, chat.id),
      chats.reserveGenerating(orgId, chat.id),
    ]);
    expect(priors.sort()).toEqual([false, true]);
    expect(await chats.isGenerating(orgId, chat.id)).toBe(true);
    // No durable work stands behind the flag: reconciling clears it.
    await chats.reconcileGenerating(orgId, chat.id);
    expect(await chats.isGenerating(orgId, chat.id)).toBe(false);
  });
});
