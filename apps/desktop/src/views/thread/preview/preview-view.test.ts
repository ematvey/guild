// Which viewer a file gets: the content type decides, the extension fills in
// when the type is generic.
import { describe, expect, it } from "vitest";
import { previewViewOf } from "./use-preview-source";

describe("previewViewOf", () => {
  it("renders html, pdf and images in place", () => {
    expect(previewViewOf("text/html", "report")).toBe("html");
    expect(previewViewOf("application/octet-stream", "report.htm")).toBe("html");
    expect(previewViewOf("application/pdf", "deck")).toBe("pdf");
    expect(previewViewOf("image/png", "shot")).toBe("image");
  });

  it("reads text as text", () => {
    expect(previewViewOf("text/markdown", "notes.md")).toBe("text");
    expect(previewViewOf("application/json", "data")).toBe("text");
  });

  it("offers only a download for anything else", () => {
    expect(previewViewOf("application/zip", "bundle.zip")).toBe("binary");
    expect(previewViewOf("", "model.bin")).toBe("binary");
  });
});
