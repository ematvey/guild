// Markup contracts for the extracted approval card and attachment chips.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ApprovalCard } from "./approval-card";
import { AttachmentFileChip, AttachmentImageThumb } from "./attachments";
import type { ApprovalBlock } from "../../lib/thread-reducer";
import type { MessageAttachmentMeta } from "../../lib/thread-events";

const approval = (over: Partial<ApprovalBlock>): ApprovalBlock => ({
  callId: "call-1",
  name: "execute",
  args: '{"command":"rm -rf build"}',
  status: "pending",
  ...over,
});

describe("ApprovalCard", () => {
  it("offers Approve and Deny while pending, with the command line", () => {
    const html = renderToStaticMarkup(<ApprovalCard a={approval({})} chatId="c1" />);
    expect(html).toContain("Execute");
    expect(html).toContain("rm -rf build");
    expect(html).toContain("Approve");
    expect(html).toContain("Deny");
  });

  it("settles to the resolved pill without buttons", () => {
    const html = renderToStaticMarkup(<ApprovalCard a={approval({ status: "approved" })} chatId="c1" />);
    expect(html).toContain("approved");
    expect(html).not.toContain(">Approve<");
  });

  it("explains an expired gate", () => {
    const html = renderToStaticMarkup(<ApprovalCard a={approval({ status: "expired" })} chatId="c1" />);
    expect(html).toContain("expired");
    expect(html).not.toContain(">Approve<");
  });
});

const att = (over: Partial<MessageAttachmentMeta>): MessageAttachmentMeta => ({
  id: "att-1",
  filename: "notes.pdf",
  content_type: "application/pdf",
  size_bytes: 2048,
  modality: "document",
  ...over,
});

describe("AttachmentFileChip", () => {
  it("opens the file in the preview pane from a transcript bubble", () => {
    const html = renderToStaticMarkup(<AttachmentFileChip att={att({})} />);
    expect(html).toContain("notes.pdf");
    expect(html).toContain("2.0 KB");
    expect(html).toContain('title="Open notes.pdf"');
  });

  it("renders a removable chip in the composer", () => {
    const html = renderToStaticMarkup(<AttachmentFileChip att={att({})} onRemove={() => {}} />);
    expect(html).toContain('title="Remove"');
    expect(html).not.toContain('title="Open notes.pdf"');
  });
});

describe("AttachmentImageThumb", () => {
  it("renders the filename and the fallback icon before the preview loads", () => {
    const html = renderToStaticMarkup(
      <AttachmentImageThumb
        att={att({ filename: "shot.png", content_type: "image/png", modality: "image", id: "pending-1" })}
      />,
    );
    expect(html).toContain('title="shot.png"');
  });
});
