import { describe, expect, it, vi } from "vitest";
import {
  BrowserSendStore,
  deserializeCommand,
  serializeCommand,
  type SendStorageBackend,
  type StoredRecord,
} from "./browser-send-store";
import {
  captureCommand,
  detachCommandDraft,
  selectRestoredCommand,
  submitCommand,
  type SubmissionIO,
} from "./outgoing-command";
import { readDraft, writeDraft, clearDrafts, scopedDraftStorage, type DraftStorage } from "./drafts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
class Memory implements SendStorageBackend {
  records = new Map<string, StoredRecord>();
  async load(scope: string) {
    return [...this.records.values()].filter((r) => r.scope === scope).map((r) => structuredClone(r));
  }
  async put(row: StoredRecord) {
    this.records.set(row.key, structuredClone(row));
  }
  async remove(key: string) {
    this.records.delete(key);
  }
  async clear(scope: string) {
    for (const [key, row] of this.records) if (row.scope === scope) this.records.delete(key);
  }
}
const attachment = (name = "original.txt") => ({
  id: `local-${name}`,
  filename: name,
  content_type: "text/plain",
  size_bytes: 5,
  modality: "text" as const,
  file: new File(["hello"], name, { type: "text/plain" }),
});
const command = () =>
  captureCommand({
    id: "stable-send",
    originChatId: "chat-a",
    chatId: "chat-a",
    text: "original",
    model: "model",
    createProjectId: null,
    prepareLocally: false,
    attachments: [attachment()],
  });
const api = (): SubmissionIO => ({
  create: vi.fn(async () => "created"),
  created: vi.fn(),
  upload: vi.fn(async (_chat, a) => ({ ...a, id: "uploaded" })),
  uploaded: vi.fn(),
  prepare: vi.fn(async (text) => ({ prompt: text })),
  submit: vi.fn(async () => {}),
});

describe("browser file and command persistence lifecycle", () => {
  it("roundtrips file bytes/name/type by account and chat without object URLs", async () => {
    const backend = new Memory();
    const store = new BrowserSendStore("api-a\naccount-a", backend);
    await store.saveDraft("chat-a", [{ ...attachment(), previewUrl: "blob:expired" }]);
    await store.saveDraft("chat-b", [attachment("other.txt")]);
    const restored = await new BrowserSendStore(store.scope, backend).restore();
    expect(restored.drafts.get("chat-a")?.[0].file?.name).toBe("original.txt");
    expect(await restored.drafts.get("chat-a")?.[0].file?.text()).toBe("hello");
    expect(restored.drafts.get("chat-a")?.[0].previewUrl).toBeUndefined();
    expect(restored.drafts.get("chat-b")?.[0].filename).toBe("other.txt");
    expect((await new BrowserSendStore("api-a\naccount-b", backend).restore()).drafts.size).toBe(0);
    expect((await new BrowserSendStore("api-b\naccount-a", backend).restore()).drafts.size).toBe(0);
  });
  it("late hydration never overwrites additions or resurrects removals", async () => {
    const backend = new Memory();
    await new BrowserSendStore("scope", backend).saveDraft("chat-a", [attachment()]);
    const snapshot = await backend.load("scope");
    const gate = deferred<StoredRecord[]>();
    backend.load = () => gate.promise;
    const store = new BrowserSendStore("scope", backend);
    const loading = store.restore();
    await store.saveDraft("chat-a", []);
    gate.resolve(snapshot);
    expect((await loading).drafts.has("chat-a")).toBe(false);
    expect([...backend.records.values()][0].value).toEqual([]);
  });
  it("typing during hydration preserves newer composer ownership", async () => {
    const backend = new Memory();
    await new BrowserSendStore("scope", backend).saveDraft(null, [attachment()]);
    const snapshot = await backend.load("scope");
    const gate = deferred<StoredRecord[]>();
    backend.load = () => gate.promise;
    const store = new BrowserSendStore("scope", backend);
    const loading = store.restore();
    store.touchDraft(null);
    gate.resolve(snapshot);
    expect((await loading).drafts.size).toBe(0);
  });
  it("signout clears queued writes and blocks late callbacks without deleting another account", async () => {
    const backend = new Memory();
    const store = new BrowserSendStore("a", backend);
    const other = new BrowserSendStore("b", backend);
    await other.saveDraft(null, [attachment("private-b.txt")]);
    const gate = deferred<void>();
    const put = backend.put.bind(backend);
    backend.put = async (row) => {
      await gate.promise;
      await put(row);
    };
    const save = store.saveDraft(null, [attachment()]);
    const clear = store.clear();
    await store.saveCommand(command());
    gate.resolve();
    await save;
    await clear;
    expect((await backend.load("a")).length).toBe(0);
    expect((await backend.load("b")).length).toBe(1);
  });
  it("settlement wins late checkpoints and in-flight hydration", async () => {
    const backend = new Memory();
    const send = command();
    const store = new BrowserSendStore("scope", backend);
    await store.saveCommand(send);
    const snapshot = await backend.load("scope");
    const gate = deferred<StoredRecord[]>();
    backend.load = () => gate.promise;
    const restoring = store.restore();
    await store.forgetCommand(send.id);
    await store.saveCommand(send);
    gate.resolve(snapshot);
    expect((await restoring).commands.size).toBe(0);
    expect(backend.records.size).toBe(0);
  });
  it("reload mid-upload retains the command ID and resumes after each successful checkpoint", async () => {
    const backend = new Memory();
    const store = new BrowserSendStore("scope", backend);
    const send = command();
    send.chatId = null;
    send.originChatId = null;
    send.attachments.push(attachment("second.txt"));
    const api1 = api();
    api1.checkpoint = (c) => store.saveCommand(c);
    api1.upload = vi.fn(async (_chat, a) => {
      if (a.filename === "second.txt") throw new Error("disconnected");
      return { ...a, id: "uploaded-first" };
    });
    await expect(submitCommand(send, api1)).rejects.toThrow("disconnected");
    const recovered = (await new BrowserSendStore("scope", backend).restore()).commands.get(send.id)!;
    expect(recovered.chatId).toBe("created");
    expect(await recovered.attachments[1].file?.text()).toBe("hello");
    const api2 = api();
    api2.submit = vi.fn(async () => {
      throw new Error("response lost");
    });
    api2.checkpoint = (c) => store.saveCommand(c);
    await expect(submitCommand(recovered, api2)).rejects.toThrow("response lost");
    expect(api2.create).not.toHaveBeenCalled();
    expect(api2.upload).toHaveBeenCalledTimes(1);
    const again = (await new BrowserSendStore("scope", backend).restore()).commands.get(send.id)!;
    const api3 = api();
    await submitCommand(again, api3);
    expect(api3.upload).not.toHaveBeenCalled();
    expect(api3.submit).toHaveBeenCalledWith("created", "stable-send", recovered.prepared);
  });
  it("delayed persistence detaches only the matching origin after navigation", async () => {
    const send = command();
    const drafts = new Map([
      ["chat-a", { text: send.text, files: send.attachments }],
      ["chat-b", { text: "newer other-chat draft", files: [attachment("newer.txt")] }],
    ]);
    let active = "chat-a";
    const gate = deferred<void>();
    const cleared: string[] = [];
    const saveThenDetach = async () => {
      await gate.promise;
      detachCommandDraft(send, {
        read: (target) => drafts.get(target!)!,
        clear: (target) => {
          drafts.set(target!, { text: "", files: [] });
          if (target === active) cleared.push(target!);
        },
      });
    };
    const saving = saveThenDetach();
    active = "chat-b";
    gate.resolve();
    await saving;
    expect(drafts.get("chat-a")).toEqual({ text: "", files: [] });
    expect(drafts.get("chat-b")?.text).toBe("newer other-chat draft");
    expect(cleared).toEqual([]);
    drafts.set("chat-a", { text: "newer origin edits", files: [attachment("newer.txt")] });
    detachCommandDraft(send, {
      read: (target) => drafts.get(target!)!,
      clear: (target) => {
        drafts.delete(target!);
      },
    });
    expect(drafts.get("chat-a")?.text).toBe("newer origin edits");
  });
  it("an exact POST fallback beats an earlier IndexedDB checkpoint", () => {
    const early = command(),
      submitted = command();
    submitted.prepared = {
      model: "original-model",
      prompt: "already submitted expansion",
      attachmentIds: ["remote-id"],
    };
    expect(selectRestoredCommand(submitted, early)).toBe(submitted);
    expect(selectRestoredCommand(undefined, early)).toBe(early);
  });
  it("an accepted echo during a delayed checkpoint prevents upload or POST", async () => {
    const send = command(),
      io = api(),
      gate = deferred<void>();
    io.checkpoint = () => gate.promise;
    const running = submitCommand(send, io);
    send.accepted = true;
    gate.resolve();
    await running;
    expect(io.upload).not.toHaveBeenCalled();
    expect(io.submit).not.toHaveBeenCalled();
    expect(send.running).toBe(false);
  });
  it("snapshots checkpoints before later command mutation", async () => {
    const send = command();
    const stored = serializeCommand(send);
    send.text = "newer";
    send.attachments.splice(0);
    const recovered = deserializeCommand(stored);
    expect(recovered.text).toBe("original");
    expect(await recovered.attachments[0].file?.text()).toBe("hello");
  });
});

it("composer text is isolated alongside files; unowned legacy text is never imported", () => {
  const data = new Map<string, string>();
  const storage: DraftStorage = {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => {
      data.set(k, v);
    },
    removeItem: (k) => {
      data.delete(k);
    },
    key: (i) => [...data.keys()][i] ?? null,
    get length() {
      return data.size;
    },
  };
  writeDraft(storage, null, "legacy secret");
  const a = scopedDraftStorage(storage, "api-a/account-a"),
    b = scopedDraftStorage(storage, "api-a/account-b");
  expect(readDraft(a, null)).toBe("");
  writeDraft(a, null, "a secret");
  writeDraft(b, null, "b secret");
  expect(readDraft(a, null)).toBe("a secret");
  expect(readDraft(b, null)).toBe("b secret");
  clearDrafts(a);
  expect(readDraft(a, null)).toBe("");
  expect(readDraft(b, null)).toBe("b secret");
});
