// Download headers: the name the user sees survives any script, and the
// preview path asks for rendering instead of saving.

import { describe, expect, it } from "vitest";
import { contentDisposition } from "../platform/domain/mime.js";
import { safeFilename } from "../platform/store/attachments.js";

describe("contentDisposition", () => {
  it("carries a non-ASCII name in the RFC 5987 form", () => {
    const value = contentDisposition("Отчет.html");
    expect(value.startsWith("attachment; filename=")).toBe(true);
    expect(value).toContain(`filename*=UTF-8''${encodeURIComponent("Отчет.html")}`);
    // The ASCII fallback stays header-safe.
    expect(value).toMatch(/^[\x20-\x7e]+$/);
  });

  it("asks for rendering in inline mode", () => {
    expect(contentDisposition("report.html", "inline").startsWith("inline;")).toBe(true);
  });

  it("escapes quotes and backslashes in the fallback", () => {
    expect(contentDisposition('a"b\\c.txt')).not.toContain('filename="a"b');
  });
});

describe("safeFilename", () => {
  it("keeps letters of any script", () => {
    expect(safeFilename("Отчет.html")).toBe("Отчет.html");
    expect(safeFilename("报告.pdf")).toBe("报告.pdf");
  });

  it("still refuses a path or an empty name", () => {
    expect(safeFilename("a/b.html")).toBe("a_b.html");
    expect(safeFilename("../etc/passwd")).toBeNull(); // leading dot
    expect(safeFilename("x/../y.html")).toBe("x_.._y.html");
    expect(safeFilename("...")).toBeNull();
  });
});
