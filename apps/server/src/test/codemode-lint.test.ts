// The static codemode script check: pure unit tests over the observed
// failure modes (see the module comment). No stack — the rules are pure
// functions of the source text.

import { describe, expect, it } from "vitest";
import { codemodeScriptLint } from "../harness/codemode-lint.js";

const blocked = (code: string): boolean => codemodeScriptLint(code) !== undefined;

describe("codemodeScriptLint", () => {
  it("lets clean scripts through", () => {
    expect(codemodeScriptLint('const r = await tools.bash({ command: "pwd" });\nreturn r;')).toBeUndefined();
    expect(codemodeScriptLint("const hits = await searchTools('gmail');\nreturn text(hits);")).toBeUndefined();
    expect(codemodeScriptLint("store('k', { n: 1 }); return await load('k');")).toBeUndefined();
  });

  it("blocks timer calls with the no-sleep teaching", () => {
    expect(blocked("await new Promise(r => setTimeout(r, 500));")).toBe(true);
    expect(blocked("setInterval(() => {}, 100);")).toBe(true);
    expect(codemodeScriptLint("setTimeout(() => {}, 100);")).toMatch(/NO timers/);
  });

  it("blocks clock busy-wait loops", () => {
    expect(blocked("const end = Date.now() + 500; while (Date.now() < end) {}")).toBe(true);
    expect(codemodeScriptLint("while (Date.now() < end) {}")).toMatch(/busy-wait/);
  });

  it("blocks sandbox globals misread as tools.* members", () => {
    expect(blocked("const hits = await tools.searchTools('gmail');")).toBe(true);
    expect(blocked("const prev = tools.load('k');")).toBe(true);
    expect(blocked("return tools.ALL_TOOLS;")).toBe(true);
  });

  it("blocks positional (non-object) tool arguments", () => {
    expect(blocked('const out = await tools.bash("pwd && ls");')).toBe(true);
    expect(blocked("const t = await tools.read('a.txt');")).toBe(true);
    // Object args — even computed or multiline — stay allowed.
    expect(blocked("await tools.read({ path: 'a.txt' })")).toBe(false);
    expect(blocked("await tools.bash(`pwd`)")).toBe(false);
  });

  it("blocks Node-isms with the no-network teaching", () => {
    expect(blocked("const fs = require('fs');")).toBe(true);
    expect(blocked("const res = await fetch('https://example.com');")).toBe(true);
    expect(codemodeScriptLint("const buf = Buffer.from('x');")).toMatch(/no Node/);
  });

  it("reports the first hit only, prefixed as a script-check block", () => {
    const hit = codemodeScriptLint('tools.load("k"); setTimeout(f, 10);');
    expect(hit?.startsWith("blocked by the codemode script check:")).toBe(true);
    expect(hit).to.contain("NO timers");
  });
});
