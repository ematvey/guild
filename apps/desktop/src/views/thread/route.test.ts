// The preview pane is address state: a file opens at its own URL, and
// leaving the thread closes it.
import { describe, expect, it } from "vitest";
import { applyRoutePatch, parseChatRoute } from "./route";


describe("preview pane in the address", () => {
  const id = "018f2c4e-0000-7000-8000-000000000001";
  it("parses the open file and the full-screen flag", () => {
    const route = parseChatRoute("/thread/c1", `?preview=attachment:${id}&full=1`);
    expect(route.preview).toEqual({ kind: "attachment", id });
    expect(route.previewFull).toBe(true);
  });

  it("ignores a malformed value and an unknown kind", () => {
    expect(parseChatRoute("/thread/c1", "?preview=attachment:not-an-id").preview).toBeUndefined();
    expect(parseChatRoute("/thread/c1", "?preview=other:" + id).preview).toBeUndefined();
    expect(parseChatRoute("/thread/c1", "?preview=attachment").preview).toBeUndefined();
  });

  it("has no pane without an open thread", () => {
    expect(parseChatRoute("/chats", `?preview=attachment:${id}`).preview).toBeUndefined();
  });

  it("drops the pane when the navigation leaves the thread", () => {
    const route = parseChatRoute("/thread/c1", `?preview=artifact:${id}`);
    expect(applyRoutePatch(route, { chatId: null }).preview).toBeNull();
    expect(applyRoutePatch(route, { chatId: "c2" }).preview).toBeNull();
    expect(applyRoutePatch(route, { previewFull: true }).preview).toEqual({ kind: "artifact", id });
  });
});
