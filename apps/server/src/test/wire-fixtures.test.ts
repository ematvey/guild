// The shared parser against the contract fixtures. protocol/fixtures holds
// one example per frame variant; this test proves @guild/wire accepts every
// one of them and that an unknown tag is rejected rather than passed on.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { parseClientFrame, parseServerFrame, serializeClientFrame } from "@guild/wire/parse";

const FIXTURES = path.resolve(process.cwd(), "../..", "protocol", "fixtures");

function frames(name: string): unknown[] {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), "utf8")) as unknown[];
}

describe("the shared socket parser", () => {
  it("accepts every server fixture", () => {
    const all = frames("socket.ServerFrame.json");
    expect(all.length).toBeGreaterThan(20);
    for (const frame of all) {
      const text = JSON.stringify(frame);
      expect(parseServerFrame(text), text).not.toBeNull();
    }
  });

  it("accepts every client fixture and round-trips it", () => {
    const all = frames("socket.ClientFrame.json");
    expect(all.length).toBeGreaterThan(4);
    for (const frame of all) {
      const text = JSON.stringify(frame);
      const parsed = parseClientFrame(text);
      expect(parsed, text).not.toBeNull();
      expect(JSON.parse(serializeClientFrame(parsed!))).toEqual(frame);
    }
  });

  it("rejects a frame whose tag the contract does not have", () => {
    expect(parseServerFrame(JSON.stringify({ type: "not_a_frame" }))).toBeNull();
    expect(parseClientFrame(JSON.stringify({ type: "thread_state" }))).toBeNull();
  });

  it("rejects text that is not a frame object", () => {
    expect(parseServerFrame("not json")).toBeNull();
    expect(parseServerFrame("[1,2]")).toBeNull();
    expect(parseServerFrame("null")).toBeNull();
    expect(parseServerFrame(JSON.stringify({ type: 7 }))).toBeNull();
  });
});
