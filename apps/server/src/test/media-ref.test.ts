// A durable entry names its images; the bytes live in object storage. These
// cover the reference format, the spill that replaces image parts, the
// install-time tool wrapper, and the resolver's per-process cache.

import { describe, expect, it } from "vitest";
import { MediaResolver, mediaRefOf, parseMediaRef, type MediaStores } from "../platform/media-ref.js";
import { spillImageParts, type SpillStores } from "../chats/media-spill.js";
import { mediaSpillingRegistry } from "../harness/media-registry.js";
import type { Registry, ToolRegistration } from "@earendil-works/pi-durable";
import { ApiError } from "../platform/errors.js";
import { afterAll, beforeAll } from "vitest";
import { setupGatewayStack, type GatewayStack } from "./support/gateway-stack.js";
import type { PlatformContext } from "../composition.js";

const ORG = "01a0e855-3892-7e02-bc92-736061fd5cca";
const CHAT = "01a1ac73-2464-7f09-beeb-dcba7a7c0704";
const CALL = "call-1";
const ARTIFACT = "01a1acfc-8391-70cd-9f6e-3a2b1c4d5e6f";

function fakeStores(): { stores: SpillStores; objects: Map<string, Buffer> } {
  const objects = new Map<string, Buffer>();
  const rows = new Map<string, { id: string; org_id: string; chat_id: string; filename: string; content_type: string; size_bytes: number; tool_name: string; call_id: string; created_at: string }>();
  const artifacts = {
    async get(_orgId: string, id: string) {
      const row = rows.get(id);
      // The spill's replay fast path reads a missing row as "not spilled yet".
      if (row === undefined) throw ApiError.notFound("no such artifact");
      return row;
    },
    async listForChat(_orgId: string, _chatId: string) {
      return [...rows.values()];
    },
    async create(id: string, orgId: string, chatId: string, filename: string, contentType: string, sizeBytes: number, _objectKey: string, toolName: string, callId: string) {
      const row = { id, org_id: orgId, chat_id: chatId, filename, content_type: contentType, size_bytes: sizeBytes, tool_name: toolName, call_id: callId, created_at: "t" };
      rows.set(id, row);
      return row;
    },
  };
  const objectStore = {
    async put(key: string, bytes: Buffer) {
      objects.set(key, bytes);
    },
    async get(key: string) {
      const bytes = objects.get(key);
      if (bytes === undefined) throw new Error(`no object ${key}`);
      return bytes;
    },
  };
  return {
    stores: { artifacts: artifacts as never, objects: objectStore as never },
    objects,
  };
}

const png = (bytes: number): string => Buffer.alloc(bytes, 7).toString("base64");

describe("media references", () => {
  it("round-trips a reference and rejects anything else", () => {
    const ref = mediaRefOf("artifact", ARTIFACT);
    expect(parseMediaRef(ref)).toEqual({ store: "artifact", id: ARTIFACT });
    expect(parseMediaRef(`data:image/png;base64,${ref}`)).toEqual({ store: "artifact", id: ARTIFACT });
    expect(parseMediaRef(`data:image/png;base64,${png(8)}`)).toBeNull();
    expect(parseMediaRef("guild-media:bogus:01a1acfc-8391-70cd-9f6e-3a2b1c4d5e6f")).toBeNull();
    expect(parseMediaRef("guild-media:artifact:not-a-uuid")).toBeNull();
  });

  it("replaces every image part with a reference and keeps text parts", async () => {
    const { stores, objects } = fakeStores();
    const parts = [
      { type: "text" as const, text: "two screenshots" },
      { type: "image" as const, mimeType: "image/png", data: png(64) },
      { type: "image" as const, mimeType: "image/png", data: png(128) },
    ];
    const out = await spillImageParts(stores, { orgId: ORG, chatId: CHAT, callId: CALL, toolName: "read" }, parts);
    expect(out.parts[0]).toEqual(parts[0]);
    const refs = out.parts.slice(1).map((part) => parseMediaRef((part as { data: string }).data));
    expect(refs.every((ref) => ref?.store === "artifact")).toBe(true);
    // Distinct rows per image of one call, and the bytes are in storage.
    expect(new Set(refs.map((ref) => ref!.id)).size).toBe(2);
    expect(out.spilled.map((row) => row.size_bytes)).toEqual([64, 128]);
    expect([...objects.values()].map((bytes) => bytes.length)).toEqual([64, 128]);
  });

  it("leaves a part that already names a reference alone", async () => {
    const { stores } = fakeStores();
    const part = { type: "image" as const, mimeType: "image/png", data: mediaRefOf("artifact", ARTIFACT) };
    const out = await spillImageParts(stores, { orgId: ORG, chatId: CHAT, callId: CALL, toolName: "read" }, [part]);
    expect(out.parts[0]).toEqual(part);
    expect(out.spilled).toEqual([]);
  });

  it("resolves a reference to bytes once, then serves it from the cache", async () => {
    const { stores, objects } = fakeStores();
    const parts = await spillImageParts(stores, { orgId: ORG, chatId: CHAT, callId: CALL, toolName: "read" }, [
      { type: "image" as const, mimeType: "image/png", data: png(16) },
    ]);
    const ref = (parts.parts[0] as { data: string }).data;
    let reads = 0;
    const counted: MediaStores = {
      objects: {
        async get(key: string) {
          reads += 1;
          return objects.get(key)!;
        },
        put: async () => {},
        delete: async () => {},
        destroy: () => {},
      } as never,
      artifacts: stores.artifacts,
      attachments: { get: async () => { throw new Error("no attachment"); } } as never,
    };
    const resolver = new MediaResolver(counted);
    const uri = `data:image/png;base64,${ref}`;
    const first = await resolver.resolve(ORG, uri);
    expect(first.startsWith("data:image/png;base64,")).toBe(true);
    expect(first).not.toContain("guild-media:");
    const second = await resolver.resolve(ORG, uri);
    expect(second).toBe(first);
    expect(reads).toBe(1);
  });

  it("returns a plain data URI untouched", async () => {
    const { stores } = fakeStores();
    const resolver = new MediaResolver({ objects: {} as never, artifacts: stores.artifacts, attachments: {} as never });
    const uri = `data:image/png;base64,${png(4)}`;
    expect(await resolver.resolve(ORG, uri)).toBe(uri);
  });
});

describe("the install-time tool wrapper", () => {
  function fakeRegistry(): { registry: Registry; installed: () => ToolRegistration[] } {
    let tools: ToolRegistration[] = [];
    const inner = {
      install: (extension: { tools?: readonly ToolRegistration[] }) => {
        tools = [...tools, ...(extension.tools ?? [])];
      },
      uninstall: () => {},
      snapshot: () => ({ extension: () => undefined, tools: () => [] }) as never,
      subscribe: () => () => {},
    } as unknown as Registry;
    const { stores } = fakeStores();
    const registry = mediaSpillingRegistry(inner, {
      stores,
      scopeOf: async () => ({ orgId: ORG, chatId: CHAT }),
    });
    return { registry, installed: () => tools };
  }

  const imageTool = (): ToolRegistration =>
    ({
      name: "read",
      description: "reads a file",
      parameters: { type: "object", properties: {} },
      execute: async () => ({
        output: [
          { type: "text", text: "the image is attached" },
          { type: "image", mimeType: "image/png", data: png(32) },
        ],
      }),
    }) as unknown as ToolRegistration;

  it("spills a tool's image parts at the install boundary", async () => {
    const { registry, installed } = fakeRegistry();
    registry.install({ name: "coding", tools: [imageTool()] } as never);
    const tool = installed()[0]!;
    const result = await tool.execute({}, { conversationId: 1, callId: CALL } as never, {} as never);
    const output = (result as { output: { type: string; data?: string }[] }).output;
    expect(output[0]).toEqual({ type: "text", text: "the image is attached" });
    expect(parseMediaRef(output[1]!.data!)).toEqual({ store: "artifact", id: expect.any(String) });
  });

  it("passes a text-only result through as the same object", async () => {
    const { registry, installed } = fakeRegistry();
    const tool = {
      ...imageTool(),
      name: "bash",
      execute: async () => ({ output: [{ type: "text", text: "ok" }] }),
    } as unknown as ToolRegistration;
    registry.install({ name: "coding", tools: [tool] } as never);
    const result = await installed()[0]!.execute({}, { conversationId: 1, callId: CALL } as never, {} as never);
    expect(result).toEqual({ output: [{ type: "text", text: "ok" }] });
  });
});

describe("against the real stores", () => {
  let stack: GatewayStack;
  let platform: PlatformContext;
  let chatId: string;

  beforeAll(async () => {
    stack = await setupGatewayStack();
    platform = (stack.env.app as unknown as { platform: PlatformContext }).platform;
    chatId = (await platform.chats.createChat(stack.orgId, stack.memberId, "media", null)).id;
  });
  afterAll(async () => {
    await stack.close();
  }, 30_000);

  it("round-trips bytes through object storage and the worker cache", async () => {
    const bytes = Buffer.alloc(4096, 3);
    const spilled = await spillImageParts(
      { artifacts: platform.toolArtifacts, objects: platform.objects },
      { orgId: stack.orgId, chatId, callId: "call-real", toolName: "read" },
      [{ type: "image" as const, mimeType: "image/png", data: bytes.toString("base64") }],
    );
    const ref = (spilled.parts[0] as { data: string }).data;
    expect(parseMediaRef(ref)?.store).toBe("artifact");
    const uri = await platform.media.resolve(stack.orgId, `data:image/png;base64,${ref}`);
    expect(uri).toBe(`data:image/png;base64,${bytes.toString("base64")}`);
    // The worker cache serves the second read of the same reference.
    const again = await platform.media.resolve(stack.orgId, `data:image/png;base64,${ref}`);
    expect(again).toBe(uri);
    // And messages resolve as a set.
    const [message] = await platform.media.resolveMessages(stack.orgId, [
      { role: "toolResult", images: [`data:image/png;base64,${ref}`] },
      { role: "user" },
    ]);
    expect((message as { images: string[] }).images[0]).toBe(uri);
  });
});
