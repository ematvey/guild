// download: one tool, two file kinds, two delivery targets. The bytes come
// from object storage — an attachment the user sent, or a tool result the
// server spilled; the destination is the environment the call runs in.

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { attachmentObjectKey, type AttachmentRow } from "../../platform/store/attachments.js";
import { toolArtifactObjectKey, type ToolArtifactRow } from "../../platform/store/tool-artifacts.js";
import { createDownloadTool } from "../../harness/chat-files.js";

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

const foreign: AttachmentRow = {
  ...statement,
  id: "33333333-3333-7333-8333-333333333333",
  chat_id: "44444444-4444-7444-8444-444444444444",
};

const spilled: ToolArtifactRow = {
  id: "01a1e3c0-0000-7000-8000-00000000abcd",
  org_id: ORG,
  chat_id: CHAT,
  filename: "Acme_Patent_Pipeline.csv",
  content_type: "text/csv",
  size_bytes: 12,
  tool_name: "drive_get_file",
  call_id: "call-1",
  created_at: "2026-11-16T09:47:28.000000Z",
};

class FakeObjects {
  readonly bytes = new Map<string, Buffer>();

  seedAttachment(row: AttachmentRow, content: string): void {
    this.bytes.set(attachmentObjectKey(ORG, row.id, row.filename), Buffer.from(content));
  }

  seedArtifact(row: ToolArtifactRow, content: string): void {
    this.bytes.set(toolArtifactObjectKey(ORG, row.id, row.filename), Buffer.from(content));
  }

  async get(key: string): Promise<Buffer> {
    const value = this.bytes.get(key);
    if (value === undefined) throw new Error(`no such object: ${key}`);
    return value;
  }
}

function harness(
  rows: readonly AttachmentRow[],
  artifacts: readonly ToolArtifactRow[],
  objects: FakeObjects,
  env: NodeExecutionEnv,
  machine?: { dir: string; requests: Array<{ machine: string; cwd?: string }> },
) {
  const tool = createDownloadTool({
    attachments: { reachableFromChat: async () => [...rows] },
    artifacts: { listForChat: async () => [...artifacts] },
    objects,
    chatOfConversation: async () => CHAT,
    orgOfConversation: async () => ORG,
    machineEnv: async (_conversationId, request) => {
      if (machine === undefined) throw new Error("no machine in this test");
      machine.requests.push(request);
      return new NodeExecutionEnv({ cwd: machine.dir });
    },
  });
  const call = (args: Record<string, unknown>) =>
    tool.execute(args as never, { conversationId: CONVERSATION, env } as never, {} as never);
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

describe("download", () => {
  it("writes an attachment to the path the caller names", async () => {
    const objects = new FakeObjects();
    objects.seedAttachment(statement, "pdf-bytes\n");
    const { call } = harness([statement, other], [], objects, new NodeExecutionEnv({ cwd: sandbox }));

    const result = await call({ file: "Statement_22.10.2026.pdf", path: "in/statement.pdf" });
    expect(result.isError).toBeUndefined();
    expect(JSON.stringify(result.output)).toContain("in/statement.pdf");
    expect(await readFile(path.join(sandbox, "in", "statement.pdf"), "utf8")).toBe("pdf-bytes\n");
  });

  it("writes a spilled tool result: the file the server saved is a chat file", async () => {
    const objects = new FakeObjects();
    objects.seedArtifact(spilled, "a,b\n1,2\n");
    const { call } = harness([], [spilled], objects, new NodeExecutionEnv({ cwd: sandbox }));

    const result = await call({ file: spilled.filename, path: "pipeline.csv" });
    expect(result.isError).toBeUndefined();
    expect(await readFile(path.join(sandbox, "pipeline.csv"), "utf8")).toBe("a,b\n1,2\n");
  });

  it("writes into a machine the call names, not into the chat's own folder", async () => {
    const objects = new FakeObjects();
    objects.seedAttachment(statement, "pdf-bytes\n");
    const dir = await mkdtemp(path.join(tmpdir(), "guild-download-machine-"));
    const machine = { dir, requests: [] as Array<{ machine: string; cwd?: string }> };
    const { call } = harness([statement], [], objects, new NodeExecutionEnv({ cwd: sandbox }), machine);

    const result = await call({ file: statement.id, path: "patents/statement.pdf", machine: "WORKSTATION-A" });
    expect(result.isError).toBeUndefined();
    expect(machine.requests).toEqual([{ machine: "WORKSTATION-A" }]);
    expect(await readFile(path.join(dir, "patents", "statement.pdf"), "utf8")).toBe("pdf-bytes\n");
    expect(await readFile(path.join(sandbox, "patents", "statement.pdf")).catch(() => null)).toBeNull();
    await rm(dir, { recursive: true, force: true });
  });

  it("writes into the project folder when the call runs on the machine", async () => {
    const objects = new FakeObjects();
    objects.seedAttachment(statement, "pdf-bytes\n");
    const { call } = harness([statement, other], [], objects, new NodeExecutionEnv({ cwd: project }));

    const result = await call({ file: statement.id, path: "docs/signed.pdf" });
    expect(result.isError).toBeUndefined();
    expect(await readFile(path.join(project, "docs", "signed.pdf"), "utf8")).toBe("pdf-bytes\n");
    expect(await readFile(path.join(sandbox, "docs", "signed.pdf"), "utf8").catch(() => null)).toBeNull();
  });

  it("refuses a download without a destination", async () => {
    const objects = new FakeObjects();
    objects.seedAttachment(statement, "pdf-bytes\n");
    const { call } = harness([statement], [], objects, new NodeExecutionEnv({ cwd: sandbox }));

    const result = await call({ file: statement.id });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.output)).toContain("path is required");
  });

  it("refuses a destination outside the working folder", async () => {
    const objects = new FakeObjects();
    objects.seedAttachment(statement, "pdf-bytes\n");
    const { call } = harness([statement], [], objects, new NodeExecutionEnv({ cwd: sandbox }));

    for (const bad of ["../escape.pdf", "/etc/escape.pdf"]) {
      const result = await call({ file: statement.id, path: bad });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.output)).toContain("path must");
    }
  });

  it("refuses to replace an existing file unless overwrite is set", async () => {
    const objects = new FakeObjects();
    objects.seedAttachment(statement, "new-bytes\n");
    const { call } = harness([statement], [], objects, new NodeExecutionEnv({ cwd: sandbox }));
    const target = path.join(sandbox, "kept.pdf");
    await writeFile(target, "old-bytes\n");

    const refused = await call({ file: statement.id, path: "kept.pdf" });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.output)).toContain("already exists");
    expect(await readFile(target, "utf8")).toBe("old-bytes\n");

    const replaced = await call({ file: statement.id, path: "kept.pdf", overwrite: true });
    expect(replaced.isError).toBeUndefined();
    expect(await readFile(target, "utf8")).toBe("new-bytes\n");
  });

  it("refuses an ambiguous filename and names the ids", async () => {
    const twin = { ...other, filename: statement.filename };
    const { call } = harness([statement, twin], [], new FakeObjects(), new NodeExecutionEnv({ cwd: sandbox }));
    const result = await call({ file: statement.filename, path: "x.pdf" });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.output)).toContain(twin.id);
  });

  it("never reads another chat's file", async () => {
    const objects = new FakeObjects();
    objects.seedAttachment(foreign, "secret\n");
    const { call } = harness([statement], [], objects, new NodeExecutionEnv({ cwd: sandbox }));
    const result = await call({ file: foreign.id, path: "secret.pdf" });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.output)).toContain(`no file named ${foreign.id}`);
  });
});
