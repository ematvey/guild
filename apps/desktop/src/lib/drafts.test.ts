// Pure-logic tests for lib/drafts (no DOM; storage is a fake over a Map).

import { describe, expect, it } from "vitest";
import {
  canPersistDraft,
  clearDrafts,
  draftKey,
  gcDrafts,
  readDraft,
  writeDraft,
  type DraftStorage,
} from "./drafts";

function fakeStorage(seed: Record<string, string> = {}): DraftStorage {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
    key: (i) => Array.from(map.keys())[i] ?? null,
    get length() {
      return map.size;
    },
  };
}

function keys(storage: DraftStorage): string[] {
  const out: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    if (k) out.push(k);
  }
  return out.sort();
}

describe("draftKey", () => {
  it("keys the scratch view as new", () => {
    expect(draftKey(null)).toBe("guild:draft:new");
    expect(draftKey("c1")).toBe("guild:draft:c1");
  });
});

describe("canPersistDraft (persist gated on the restore it belongs to)", () => {
  it("blocks the first mount, before any restore ran", () => {
    // The persist effect runs before the chatId effect's first restore.
    expect(canPersistDraft(undefined, "c1")).toBe(false);
    expect(canPersistDraft(undefined, null)).toBe(false);
  });

  it("blocks the switch window: new chatId, previous chat's prompt", () => {
    // Regression: on a chat switch the persist effect fired first with the
    // NEW chatId while the prompt still held the previous chat's text,
    // persisting it as the destination's draft and destroying that draft
    // before its restore read it.
    expect(canPersistDraft("a", "b")).toBe(false);
  });

  it("allows writes once the restore ran for the open chat", () => {
    expect(canPersistDraft("b", "b")).toBe(true);
    expect(canPersistDraft(null, null)).toBe(true); // scratch view
    expect(canPersistDraft(null, "b")).toBe(false);
    expect(canPersistDraft("b", null)).toBe(false);
  });
});

describe("readDraft / writeDraft", () => {
  it("round-trips per chat", () => {
    const storage = fakeStorage();
    writeDraft(storage, "c1", "hello");
    writeDraft(storage, null, "scratch");
    expect(readDraft(storage, "c1")).toBe("hello");
    expect(readDraft(storage, null)).toBe("scratch");
    expect(readDraft(storage, "c2")).toBe("");
  });

  it("swallows storage failures (drafts are best-effort)", () => {
    const boom = (): never => {
      throw new Error("quota");
    };
    const storage: DraftStorage = {
      getItem: boom,
      setItem: boom,
      removeItem: boom,
      key: boom,
      get length(): number {
        return boom();
      },
    };
    expect(readDraft(storage, "c1")).toBe("");
    expect(() => writeDraft(storage, "c1", "x")).not.toThrow();
  });
});

describe("gcDrafts", () => {
  it("drops only the drafts of chats that left the lists", () => {
    const storage = fakeStorage({
      "guild:draft:a": "a",
      "guild:draft:b": "b",
      "guild:draft:new": "scratch",
      "guild:token": "keep-me",
    });
    gcDrafts(storage, new Set(["b"]));
    expect(keys(storage)).toEqual(["guild:draft:b", "guild:draft:new", "guild:token"]);
  });

  it("drops every chat draft when no chat qualifies (only the scratch draft survives)", () => {
    const storage = fakeStorage({ "guild:draft:a": "a", "guild:draft:new": "scratch" });
    gcDrafts(storage, new Set());
    expect(keys(storage)).toEqual(["guild:draft:new"]);
  });

  it("swallows storage failures", () => {
    const storage: DraftStorage = {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
      key: () => {
        throw new Error("unavailable");
      },
      get length(): number {
        return 0;
      },
    };
    expect(() => gcDrafts(storage, new Set(["a"]))).not.toThrow();
  });
});

describe("clearDrafts (sign-out)", () => {
  it("removes every draft key and nothing else", () => {
    const storage = fakeStorage({
      "guild:draft:a": "a",
      "guild:draft:b": "b",
      "guild:token": "keep-me",
    });
    clearDrafts(storage);
    expect(keys(storage)).toEqual(["guild:token"]);
  });
});

it("requires complete archived and active inventories before collecting drafts", async () => {
  const { completeDraftInventory } = await import("./drafts");
  expect(completeDraftInventory([{ id: "active" }], null, null)).toBeNull();
  expect(completeDraftInventory(null, [{ id: "archived" }], null)).toBeNull();
  expect([...completeDraftInventory([{ id: "active" }], [{ id: "archived" }], "open")!]).toEqual(["active", "archived", "open"]);
});


it("signout clears persisted outgoing commands with composer drafts", () => {
  const storage = fakeStorage({ "guild:outgoing:account:message": "payload", "guild:draft:a": "text", unrelated: "keep" });
  clearDrafts(storage);
  expect(keys(storage)).toEqual(["unrelated"]);
});
