// The served web bundle's identity: the entry script hash index.html
// loads, which the workspace_identity frame carries to browser clients.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { servedWebBundle, webBundleId } from "../platform/web-bundle.js";

function dist(index: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), "guild-web-"));
  if (index !== null) writeFileSync(join(dir, "index.html"), index);
  return dir;
}

describe("web bundle identity", () => {
  it("reads the entry script hash from index.html", () => {
    const html = '<script type="module" crossorigin src="/assets/index-Bx3k9aQd.js"></script>';
    expect(webBundleId({ file: () => Buffer.from(html) })).toBe("Bx3k9aQd");
    expect(servedWebBundle({ webDistDir: dist(html) })).toBe("Bx3k9aQd");
  });

  it("is null without a served bundle", () => {
    expect(webBundleId({ file: () => null })).toBeNull();
    expect(servedWebBundle({ webDistDir: dist(null) })).toBeNull();
    expect(servedWebBundle({ webDistDir: null })).toBeNull();
    expect(webBundleId({ file: () => Buffer.from("<html></html>") })).toBeNull();
  });
});
