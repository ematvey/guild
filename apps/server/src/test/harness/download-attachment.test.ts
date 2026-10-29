// download_attachment: one tool, two delivery targets. The bytes come from
// object storage; the destination is whatever environment the call runs in —
// the chat's sandbox or the bound project folder on the user's machine.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { attachmentObjectKey, type AttachmentRow } from "../../platform/store/attachments.js";
import { createDownloadAttachmentTool } from "../../harness/attachment-tools.js";

const CHAT = "11111111-1111-7111-8111-111111111111";
const ORG = "22222222-2222-7222-8222-222222222222";
const CONVERSATION = 7 as never;

const statement: AttachmentRow = {
  id: "01a18389-077a-7c77-b405-e27d9f7d1c29",
  org_id: ORG,
  chat_id: CHAT,
  filename: "Statement_22.10.2026.pdf",
  content_type: "application/pdf",
  size_bytes: 11,
  created_at: "2026-10-28T17:22:38.000000Z",
};

const other: AttachmentRow = {
  ...statement,
  id: "01a183b0-57ac-7696-abc0-a49ef08379d2",
  filename: "Statement_22.10.2026.docx",
  content_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

const foreign: AttachmentRow = { ...statement, id: "33333333-3333-7333-8333-333333333333", chat_id: "44444444-4444-7444-8444-444444444444" };

class FakeObjects {
  readonly bytes = new Map<string, Buffer>();

  seed(row: AttachmentRow, content: string): void {
    this.bytes.set(attachmentObjectKey(ORG, row.id, row.filename), Buffer.from(content));
  }

  async get(key: string): Promise<Buffer> {
    const value = this.bytes.get(key);
    if (value === undefined) throw new Error(`no such object: ${key}`);
    return value;
  }
}

function harness(rows: readonly AttachmentRow[], objects: FakeObjects, env: NodeExecutionEnv) {
  const tool = createDownloadAttachmentTool({
    attachments: { list: async () => [...rows] },
    objects,
    chatOfConversation: async () => CHAT,
    orgOfConversation: async () => ORG,
  });
  const call = (args: Record<string, unknown>) => tool.execute(args as never, { conversationId: CONVERSATION, env } as never, {} as never);
  return { tool, call };
}

let sandbox: string;
let project: string;

beforeAll(async () => {
  sandbox = await mkdtemp(path.join(tmpdir(), "guild-download-sandbox-"));
  project = await mkdtemp(path.join(tmpdir(), "guild-download-project-"));
});

afterAll(async () => {
  await rm(sandbox, { recursive: true, force: true }).catch(() => {});
  await rm(project, { recursive: true, force: true }).catch(() => {});
});

describe("download_attachment", () => {
  it("writes into the sandbox environment by default", async () => {
    const objects = new FakeObjects();
    objects.seed(statement, "pdf-bytes\n");
    const { call } = harness([statement, other], objects, new NodeExecutionEnv({ cwd: sandbox }));

    const result = await call({ filename: "Statement_22.10.2026.pdf" });
    expect(result.isError).toBeUndefined();
    expect(JSON.stringify(result.output)).toContain("attachments/Statement_22.10.2026.pdf");
    expect(await readFile(path.join(sandbox, "attachments", "Statement_22.10.2026.pdf"), "utf8")).toBe("pdf-bytes\n");
  });

  it("writes into the project folder when the call runs on the machine", async () => {
    const objects = new FakeObjects();
    objects.seed(statement, "pdf-bytes\n");
    const { call } = harness([statement, other], objects, new NodeExecutionEnv({ cwd: project }));

    const result = await call({ attachment_id: statement.id, path: "docs/signed.pdf" });
    expect(result.isError).toBeUndefined();
    expect(await readFile(path.join(project, "docs", "signed.pdf"), "utf8")).toBe("pdf-bytes\n");
    expect(await readFile(path.join(sandbox, "docs", "signed.pdf"), "utf8").catch(() => null)).toBeNull();
  });

  it("lists this chat's attachments when no selector is given", async () => {
    const { call } = harness([statement, other], new FakeObjects(), new NodeExecutionEnv({ cwd: sandbox }));
    const result = await call({});
    expect(result.isError).toBe(true);
    const text = JSON.stringify(result.output);
    expect(text).toContain(statement.id);
    expect(text).toContain(statement.filename);
    expect(text).toContain(other.filename);
  });

  it("refuses an ambiguous filename and names the ids", async () => {
    const twin = { ...other, filename: statement.filename };
    const { call } = harness([statement, twin], new FakeObjects(), new NodeExecutionEnv({ cwd: sandbox }));
    const result = await call({ filename: statement.filename });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.output)).toContain(twin.id);
  });

  it("never reads another chat's attachment", async () => {
    const objects = new FakeObjects();
    objects.seed(foreign, "secret\n");
    const { call } = harness([statement], objects, new NodeExecutionEnv({ cwd: sandbox }));
    const result = await call({ attachment_id: foreign.id });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.output)).toContain(`no attachment with id ${foreign.id}`);
  });
});
