// Wedge hardening (2026-10-15 incident): the models catalog must survive an
// empty route read, and turn commands whose delivery failed must not stay
// pending forever.

import { createModels } from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { setupGatewayStack, type GatewayStack } from "./support/gateway-stack.js";
import { ensureOrgProvider, guildProviderId, type GuildRouteInfo } from "../harness/models.js";
import { TurnCommandStore } from "../platform/store/turn-commands.js";

const route = (model: string): GuildRouteInfo => ({
  model,
  reasoning: false,
  context_window: null,
  max_output_tokens: null,
  price_in: 0,
  price_out: 0,
});

describe("wedge hardening", () => {
  it("an empty route read does not wipe the org's model catalog", () => {
    const models = createModels();
    const org = randomUUID();
    const config = { selfBaseUrl: "http://127.0.0.1:1", internalKey: "internal-key" };
    ensureOrgProvider(models, config, org, [route("GLM-Test-Model")]);
    expect(models.getModel(guildProviderId(org), "GLM-Test-Model")).toBeDefined();
    // The transient empty read: the previous catalog keeps serving.
    ensureOrgProvider(models, config, org, []);
    expect(models.getModel(guildProviderId(org), "GLM-Test-Model")).toBeDefined();
  });

  describe("turn commands: failed delivery and expiry sweep", () => {
    let stack: GatewayStack;
    let commands: TurnCommandStore;
    let chatId: string;

    afterAll(async () => {
      if (stack !== undefined) await stack.close();
    });

    it("seeds the stack", async () => {
      stack = await setupGatewayStack({}, { dbPrefix: "guild_wedge_test", logLevel: "error" });
      commands = new TurnCommandStore(stack.env.db);
      const res = await stack.env.app.inject({
        method: "POST",
        url: "/api/v1/chats",
        headers: { authorization: `Bearer ${stack.memberToken}`, "content-type": "application/json" },
        payload: { title: "wedge test" },
      });
      expect(res.statusCode).toBe(200);
      chatId = (JSON.parse(res.body) as { id: string }).id;
    });

    it("marks a never-delivered command failed", async () => {
      const id = randomUUID();
      await commands.accept(
        id,
        stack.orgId,
        stack.memberId,
        chatId,
        { user_message_id: id },
        { user_message_id: id },
        { content: "hello", attachments: [] },
      );
      expect((await commands.byId(id, chatId))!.status).toBe("pending");
      await commands.failUnsubmitted(id);
      expect((await commands.byId(id, chatId))!.status).toBe("failed");
      // A settled row keeps its outcome across repeat calls and sweeps.
      await commands.failUnsubmitted(id);
      expect((await commands.byId(id, chatId))!.status).toBe("failed");
    });

    it("sweeps expired pending commands but leaves fresh ones", async () => {
      const fresh = randomUUID();
      await commands.accept(
        fresh,
        stack.orgId,
        stack.memberId,
        chatId,
        { user_message_id: fresh },
        { user_message_id: fresh },
        { content: "fresh", attachments: [] },
      );
      // Nothing is old enough yet.
      expect(await commands.sweepExpired(15 * 60)).toBe(0);
      expect((await commands.byId(fresh, chatId))!.status).toBe("pending");
      // Backdating the created_at makes the command expire.
      await stack.env.db.query("UPDATE turn_commands SET created_at = created_at - interval '1 hour' WHERE id = $1", [fresh]);
      expect(await commands.sweepExpired(15 * 60)).toBeGreaterThanOrEqual(1);
      expect((await commands.byId(fresh, chatId))!.status).toBe("failed");
    });
  });
});
