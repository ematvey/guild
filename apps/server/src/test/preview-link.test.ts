// Signed preview links: the frame cannot send an Authorization header, so the
// URL carries a signature that covers the file and an expiry.

import { describe, expect, it } from "vitest";
import {
  PREVIEW_CSP,
  previewLinkPath,
  previewReply,
  verifyPreviewLink,
} from "../platform/http/preview-link.js";

const SECRET = "test-secret";
const ID = "018f2c4e-0000-7000-8000-000000000001";

const sigOf = (path: string): string => {
  const url = new URL(path, "http://x");
  return url.searchParams.get("preview") ?? "";
};

describe("previewLinkPath", () => {
  it("names the byte route with an inline flag and a signature", () => {
    const path = previewLinkPath(SECRET, "attachment", ID);
    expect(path.startsWith(`/api/v1/attachments/${ID}?inline=1&preview=`)).toBe(true);
    expect(sigOf(path)).toMatch(/^\d+\.[0-9a-f]{64}$/);
  });

  it("routes an artifact to its own byte route", () => {
    expect(previewLinkPath(SECRET, "artifact", ID).startsWith(`/api/v1/tool_artifacts/${ID}?`)).toBe(true);
  });

  it("verifies a fresh link and refuses an expired one", () => {
    const now = Date.now();
    const fresh = previewLinkPath(SECRET, "attachment", ID, now);
    expect(() => verifyPreviewLink(SECRET, "attachment", ID, sigOf(fresh))).not.toThrow();
    const old = previewLinkPath(SECRET, "attachment", ID, now - 3_600_000);
    expect(() => verifyPreviewLink(SECRET, "attachment", ID, sigOf(old))).toThrow(/expired/);
  });

  it("refuses a forged, re-targeted or foreign-secret link", () => {
    const path = previewLinkPath(SECRET, "attachment", ID);
    const sig = sigOf(path);
    expect(() => verifyPreviewLink(SECRET, "attachment", "018f2c4e-0000-7000-8000-000000000002", sig)).toThrow();
    expect(() => verifyPreviewLink(SECRET, "artifact", ID, sig)).toThrow();
    expect(() => verifyPreviewLink("other-secret", "attachment", ID, sig)).toThrow();
    expect(() => verifyPreviewLink(SECRET, "attachment", ID, "garbage")).toThrow();
  });
});

describe("previewReply", () => {
  it("serves inline under a sandboxing policy", () => {
    const sent: { headers: Record<string, string>; status: number } = { headers: {}, status: 0 };
    const reply = {
      status(code: number) {
        sent.status = code;
        return this;
      },
      type() {
        return this;
      },
      header(name: string, value: string) {
        sent.headers[name] = value;
        return this;
      },
      send() {
        return "sent";
      },
    };
    previewReply(reply, Buffer.from("hi"), { filename: "Отчет.html", content_type: "text/html" });
    expect(sent.status).toBe(200);
    expect(sent.headers["content-disposition"]).toBe(`inline; filename*=UTF-8''${encodeURIComponent("Отчет.html")}`);
    expect(sent.headers["content-security-policy"]).toBe(PREVIEW_CSP);
    expect(PREVIEW_CSP).toContain("sandbox");
  });
});
