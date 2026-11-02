import { describe, expect, it, vi } from "vitest";
import {
  captureCommand,
  forgetCommand,
  rememberCommand,
  restoreCommands,
  matchesCommandDraft,
  prepareOnSendingMachine,
  recoveryDraft,
  submitCommand,
  type DraftAttachment,
  type SubmissionIO,
} from "./outgoing-command";

const attachment = (id: string): DraftAttachment => ({
  id,
  filename: `${id}.txt`,
  content_type: "text/plain",
  size_bytes: 3,
  modality: "text",
  file: { name: `${id}.txt` } as File,
});
const command = (files: DraftAttachment[] = []) =>
  captureCommand({
    id: "stable-id",
    originChatId: "chat-a",
    chatId: "chat-a",
    text: "original",
    model: "model-a",
    createProjectId: null,
    prepareLocally: true,
    attachments: files,
  });
const io = (): SubmissionIO => ({
  create: vi.fn(async () => "created-chat"),
  created: vi.fn(),
  upload: vi.fn(async (_chat, a) => ({ ...a, id: `uploaded-${a.id}` })),
  uploaded: vi.fn(),
  prepare: vi.fn(async (text) => ({ prompt: `${text} expanded`, instructions: "original instructions" })),
  submit: vi.fn(async () => {}),
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((ok, bad) => {
    resolve = ok;
    reject = bad;
  });
  return { promise, resolve, reject };
}

describe("outgoing command lifecycle used by WebChat", () => {
  it("moves a fixed attachment snapshot across delayed create and navigation", async () => {
    const files = [attachment("a")];
    const send = command(files);
    send.chatId = null;
    send.originChatId = null;
    const api = io();
    const create = deferred<string>();
    api.create = vi.fn(() => create.promise);
    const delivery = submitCommand(send, api);
    files.splice(0, 1, attachment("new-chat-file"));
    create.resolve("original-chat");
    await delivery;
    expect(api.upload).toHaveBeenCalledWith("original-chat", expect.objectContaining({ id: "a" }));
    expect(send.prepared?.attachmentIds).toEqual(["uploaded-a"]);
    expect(api.created).toHaveBeenCalledWith("original-chat");
  });

  it("lost submit response retries the exact identity/body without new uploads or context", async () => {
    const send = command([attachment("a")]);
    const api = io();
    const bodies: string[] = [];
    api.submit = vi.fn(async (chat, id, body) => {
      bodies.push(JSON.stringify({ chat, id, body }));
      if (bodies.length === 1) throw new Error("response lost");
    });
    await expect(submitCommand(send, api)).rejects.toThrow("response lost");
    api.prepare = vi.fn(async () => ({ prompt: "NEW CONTEXT SHOULD NOT WIN" }));
    await submitCommand(send, api);
    expect(bodies[0]).toBe(bodies[1]);
    expect(api.upload).toHaveBeenCalledTimes(1);
    expect(api.prepare).not.toHaveBeenCalled();
    expect(send.accepted).toBe(true);
  });

  it("a partially failed upload resumes without duplicating successful attachments", async () => {
    const send = command([attachment("a"), attachment("b")]);
    const api = io();
    let fail = true;
    api.upload = vi.fn(async (_cid, a) => {
      if (a.id === "b" && fail) {
        fail = false;
        throw new Error("offline");
      }
      return { ...a, id: `remote-${a.id}` };
    });
    await expect(submitCommand(send, api)).rejects.toThrow("offline");
    expect(api.submit).not.toHaveBeenCalled();
    await submitCommand(send, api);
    expect(vi.mocked(api.upload).mock.calls.map((c) => c[1].id)).toEqual(["a", "b", "b"]);
    expect(send.prepared?.attachmentIds).toEqual(["remote-a", "remote-b"]);
  });

  it("a durable echo reconciles a lost response without offering another send", async () => {
    const send = command();
    const api = io();
    api.submit = vi.fn(async () => {
      send.accepted = true;
      throw new Error("response lost after echo");
    });
    await expect(submitCommand(send, api)).resolves.toBeUndefined();
    await submitCommand(send, api);
    expect(api.submit).toHaveBeenCalledTimes(1);
    expect(send.error).toBeUndefined();
  });

  it("create rejection retains text/files and does not submit an empty turn", async () => {
    const send = command([attachment("a")]);
    send.chatId = null;
    const api = io();
    api.create = vi.fn(async () => {
      throw new Error("offline");
    });
    await expect(submitCommand(send, api)).rejects.toThrow("offline");
    expect(recoveryDraft(send, "", []).text).toBe("original");
    expect(recoveryDraft(send, "", []).files[0].id).toBe("a");
    expect(api.upload).not.toHaveBeenCalled();
    expect(api.submit).not.toHaveBeenCalled();
  });

  it("failure recovery preserves newer text and files in either origin draft", () => {
    const send = command([attachment("old")]);
    expect(recoveryDraft(send, "newer draft", []).text).toBe("newer draft");
    expect(recoveryDraft(send, "", [attachment("new")]).files[0].id).toBe("new");
    expect(recoveryDraft(send, "newer draft", []).restored).toBe(false);
    expect(matchesCommandDraft(send, "original", send.attachments)).toBe(true);
    expect(matchesCommandDraft(send, "edited", send.attachments)).toBe(false);
  });

  it("remote and unknown project owners skip the sender's daemon entirely", async () => {
    expect(prepareOnSendingMachine(true, true, "machine-b", "machine-a")).toBe(false);
    expect(prepareOnSendingMachine(true, true, undefined, "machine-a")).toBe(false);
    expect(prepareOnSendingMachine(true, true, "machine-a", "machine-a")).toBe(true);
    const send = command();
    send.prepareLocally = false;
    const api = io();
    await submitCommand(send, api);
    expect(api.prepare).not.toHaveBeenCalled();
    expect(send.prepared?.instructions).toBeUndefined();
    expect(send.prepared?.prompt).toBe("original");
  });
});

it("reload recovery preserves exact accepted payload and is scoped to the account/server", async () => {
  const values = new Map<string, string>();
  const storage = {
    get length() {
      return values.size;
    },
    key: (n: number) => [...values.keys()][n] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
  const send = command([attachment("a")]);
  const api = io();
  api.submit = vi.fn(async () => {
    rememberCommand(storage, "server/account-a", send);
    throw new Error("lost response");
  });
  await expect(submitCommand(send, api)).rejects.toThrow();
  const restored = restoreCommands(storage, "server/account-a").get(send.id)!;
  expect(restoreCommands(storage, "server/account-b").size).toBe(0);
  expect(restored.prepared).toEqual(send.prepared);
  expect(restored.attachments[0].file).toBeUndefined();
  const retry = io();
  await submitCommand(restored, retry);
  expect(retry.upload).not.toHaveBeenCalled();
  expect(retry.prepare).not.toHaveBeenCalled();
  expect(retry.submit).toHaveBeenCalledWith("chat-a", "stable-id", send.prepared);
  forgetCommand(storage, "server/account-a", send.id);
  expect(restoreCommands(storage, "server/account-a").size).toBe(0);
});

it("a restored command keeps the local attachment ID so a reload retry still matches the draft", async () => {
  const values = new Map<string, string>();
  const storage = {
    get length() {
      return values.size;
    },
    key: (n: number) => [...values.keys()][n] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
  const send = command([attachment("local-a")]);
  const api = io();
  api.submit = vi.fn(async () => {
    rememberCommand(storage, "server/account-a", send);
    throw new Error("lost response");
  });
  await expect(submitCommand(send, api)).rejects.toThrow();
  const restored = restoreCommands(storage, "server/account-a").get(send.id)!;
  // The composer draft recovered after the reload keeps the local ID.
  expect(matchesCommandDraft(restored, "original", [attachment("local-a")])).toBe(true);
  expect(recoveryDraft(restored, "", []).files[0].id).toBe("local-a");
  // The prepared payload still carries the server IDs.
  expect(restored.prepared?.attachmentIds).toEqual(["uploaded-local-a"]);
  const retry = io();
  await submitCommand(restored, retry);
  expect(retry.upload).not.toHaveBeenCalled();
  expect(retry.submit).toHaveBeenCalledWith("chat-a", "stable-id", restored.prepared);
});

describe("restored file-less attachments", () => {
  it("reuse their uploadedAs server metadata instead of the local id", async () => {
    const fileless: DraftAttachment = {
      id: "local-1",
      filename: "a.txt",
      content_type: "text/plain",
      size_bytes: 3,
      modality: "text",
      uploadedAs: {
        id: "8e0f3a2b-1111-4ccc-8ddd-222233334444",
        filename: "a.txt",
        content_type: "text/plain",
        size_bytes: 3,
        modality: "text",
      },
    };
    const send = command([fileless]);
    const api = io();
    await submitCommand(send, api);
    expect(api.upload).not.toHaveBeenCalled();
    expect(send.prepared?.attachmentIds).toEqual(["8e0f3a2b-1111-4ccc-8ddd-222233334444"]);
  });

  it("restoreCommands heals the stamp from the persisted upload map", () => {
    const send = command([attachment("a")]);
    send.chatId = "chat-a";
    send.prepared = { model: "m", prompt: "p", attachmentIds: ["remote-a"], projectId: null, sendMode: undefined };
    send.uploaded.set("a", {
      id: "remote-a",
      filename: "a.txt",
      content_type: "text/plain",
      size_bytes: 3,
      modality: "text",
    });
    // Persist exactly as rememberCommand does (attachments without file).
    const row = JSON.stringify({
      ...send,
      attachments: send.attachments.map(({ file: _f, previewUrl: _p, ...meta }) => meta),
      uploaded: [...send.uploaded],
      running: false,
      accepted: false,
      error: "retry",
    });
    const prefix = `guild:outgoing:${encodeURIComponent("test-scope")}:`;
    const fake = {
      length: 1,
      key: (_i: number) => prefix + send.id,
      getItem: (_k: string) => row,
    };
    const restored = restoreCommands(fake as unknown as Storage, "test-scope");
    const got = restored.get(send.id)!;
    expect(got.attachments[0].uploadedAs?.id).toBe("remote-a");
    // An edited re-send of the restored draft (fresh command, same drafts)
    // then submits the server id.
    const edited = captureCommand({
      id: "edited-id",
      originChatId: "chat-a",
      chatId: "chat-a",
      text: "edited",
      model: "m",
      createProjectId: null,
      prepareLocally: false,
      attachments: got.attachments,
    });
    const api = io();
    return submitCommand(edited, api).then(() => {
      expect(api.upload).not.toHaveBeenCalled();
      expect(edited.prepared?.attachmentIds).toEqual(["remote-a"]);
    });
  });
});
