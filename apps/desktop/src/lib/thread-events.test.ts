// The one thread read that does not ride the member socket: an older page
// of the durable log. It carries the bearer, refreshes a lapsed session
// once, and surfaces a failed read instead of an empty page.

import { afterEach, describe, expect, it, vi } from "vitest";

function store(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

describe("thread reads", () => {
  afterEach(() => vi.unstubAllGlobals());

  function setup(response: Response | (() => Response)) {
    vi.stubGlobal("window", { location: { origin: "http://localhost:18080" } });
    vi.stubGlobal("localStorage", store({ guild_token: "tok" }));
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        return typeof response === "function" ? response() : response;
      }),
    );
    return calls;
  }

  it("requests the page before the watermark with the bearer", async () => {
    const calls = setup(new Response(JSON.stringify({ events: [], has_more: false }), { status: 200 }));
    const { fetchThreadEventsPage } = await import("./thread-events");
    const page = await fetchThreadEventsPage("c 1", 42, 20, new AbortController().signal);
    expect(page).toEqual({ events: [], has_more: false });
    expect(calls[0].url).toBe("/api/v1/threads/c%201/events?before=42&limit=20");
    expect((calls[0].init!.headers as Record<string, string>).authorization).toBe("Bearer tok");
  });

  it("rejects a failed page read", async () => {
    setup(new Response("nope", { status: 500 }));
    const { fetchThreadEventsPage } = await import("./thread-events");
    await expect(fetchThreadEventsPage("c1", 10, 20, new AbortController().signal)).rejects.toMatchObject({
      status: 500,
    });
  });
});
