// Chat write contracts: the URL, the method and the body the server sees.
// These are the calls a UI bug would break silently (a null result, a
// missing project, a lost steer), so each test asserts the wire.

import { afterEach, describe, expect, it, vi } from "vitest";

function store() {
  const map = new Map<string, string>([["guild_token", "tok"]]);
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

type Call = { url: string; init: RequestInit };

function setup(response: () => Response | Promise<Response>): Call[] {
  vi.stubGlobal("window", { location: { origin: "http://localhost:18080" } });
  vi.stubGlobal("localStorage", store());
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      return response();
    }),
  );
  return calls;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("chat writes", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("creates a thread with the picked project", async () => {
    const calls = setup(() => json({ id: "chat-9" }));
    const { createChat } = await import("./chats");
    expect(await createChat("Hello", "p1")).toBe("chat-9");
    expect(calls[0].url).toBe("/api/v1/threads");
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ title: "Hello", project_id: "p1" });
  });

  it("omits the project when none is picked", async () => {
    const calls = setup(() => json({ id: "chat-9" }));
    const { createChat } = await import("./chats");
    await createChat("Hello", null);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ title: "Hello" });
  });

  it("returns null when the create is rejected", async () => {
    setup(() => new Response("no", { status: 400 }));
    const { createChat } = await import("./chats");
    expect(await createChat("Hello")).toBeNull();
  });

  it("stops the running turn of the named chat", async () => {
    const calls = setup(() => new Response(null, { status: 200 }));
    const { stopChat } = await import("./chats");
    expect(await stopChat("c1")).toBe(true);
    expect(calls[0].url).toBe("/api/v1/threads/c1/stop");
    expect(calls[0].init.method).toBe("POST");
  });

  it("reports a refused stop", async () => {
    setup(() => new Response(null, { status: 409 }));
    const { stopChat } = await import("./chats");
    expect(await stopChat("c1")).toBe(false);
  });

  it("steers a queued message", async () => {
    const calls = setup(() => json({ status: "steering" }));
    const { steerQueued } = await import("./chats");
    expect(await steerQueued("c1", "m1")).toBe("steering");
    expect(calls[0].url).toBe("/api/v1/threads/c1/pending/m1/steer");
    expect(calls[0].init.method).toBe("POST");
  });

  it("reads a refused steer from the error envelope's code", async () => {
    const calls = setup(() => json({ error: { code: "not_admitted", message: "not yet admitted" } }, 409));
    const { steerQueued } = await import("./chats");
    expect(await steerQueued("c1", "m1")).toBe("pending");
    expect((calls[0].init.headers as Record<string, string>)["x-guild-client-id"]).toBeTruthy();
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer tok");
  });

  it("fails a rejected rename with the server's message", async () => {
    setup(() => json({ error: { code: "bad_request", message: "title too long" } }, 400));
    const { updateChat } = await import("./chats");
    const { ApiError } = await import("./request");
    const failure = await updateChat("c1", { title: "x" }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as InstanceType<typeof ApiError>).message).toBe("title too long");
    expect((failure as InstanceType<typeof ApiError>).status).toBe(400);
  });

  it("withdraws a queued message", async () => {
    const calls = setup(() => new Response(null, { status: 200 }));
    const { withdrawQueued } = await import("./chats");
    expect(await withdrawQueued("c1", "m1")).toBe(true);
    expect(calls[0].url).toBe("/api/v1/threads/c1/pending/m1");
    expect(calls[0].init.method).toBe("DELETE");
  });

  it("renames a chat", async () => {
    const calls = setup(() => json({ id: "c1", title: "New" }));
    const { updateChat } = await import("./chats");
    await updateChat("c1", { title: "New" });
    expect(calls[0].url).toBe("/api/v1/threads/c1");
    expect(calls[0].init.method).toBe("PATCH");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ title: "New" });
  });
});
