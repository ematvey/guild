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

// The classifier is supplied by the admitted integration declarations in
// production. A generic API's ceiling is write, even when a request reads.
const readCall = (name: string, args: Record<string, unknown>): boolean =>
  name === "catalog_get" ||
  (name === "hubspot_api" &&
    ((args.method === undefined && !("method" in args)) ||
      args.method === "GET" ||
      (args.method === "POST" && args.path === "/crm/v3/objects/contacts/search")));
const lint = (code: string) => codemodeScriptLint(code, readCall);

describe("independent read static check", () => {
  const helper = `async function api(args) {
    try { return String(await tools.hubspot_api(args)); }
    catch (e) { return "ERR: " + e.message; }
  }`;

  it("catches the recorded list-name lookup shape before execution", () => {
    const code = `${helper}
      const raw = await api({path: "/crm/v3/lists/records/0-1/sample-contact/memberships"});
      const ids = [...raw.matchAll(/"listId":"(\\d+)"/g)].map(m => m[1]);
      const names = [];
      for (const id of ids) {
        const t = await api({path: \`/crm/v3/lists/\${id}\`});
        let nm = (t.match(/"name":"([^"]*)"/) || [])[1] || "?";
        let proc = (t.match(/"processingType":"([^"]*)"/) || [])[1] || "";
        names.push(id + " | " + nm + " | " + proc);
      }
      text(names.join("\\n"));`;
    expect(lint(code)).toContain("Promise.all");
    expect(lint(code)).toContain("line 8");
  });

  it("catches the recorded failed-lookup retry shape", () => {
    expect(
      lint(`${helper}
      const ids = [1,2,3,4,5]; const out = [];
      for (const id of ids) {
        const t = await api({path: \`/crm/v3/lists/\${id}\`});
        out.push(id + " => " + t.slice(0,300));
      }
      text(out.join("\\n"));`),
    ).toContain("Promise.all");
  });

  it("accepts the parallel rewrite", () => {
    expect(
      lint(`${helper}
      const ids = [1,2,3,4];
      const out = await Promise.all(ids.map(async (id) => {
        const t = await api({path: \`/crm/v3/lists/\${id}\`});
        return id + " => " + t.slice(0,300);
      })); text(out.join("\\n"));`),
    ).toBeUndefined();
  });

  it("catches independent adjacent reads but permits dependent reads", () => {
    const batch = [1, 2, 3, 4].map((id) => `const r${id} = await tools.catalog_get({id: ${id}});`).join("\n");
    expect(lint(batch)).toContain("Promise.all");
    expect(lint(batch.replace("id: 3", "id: r2"))).toBeUndefined();
  });

  it("recognizes read-class tools and fixed POST search operations", () => {
    expect(lint("for (const id of [1,2,3,4]) { const r = await tools.catalog_get({id}); text(r); }")).toContain(
      "Promise.all",
    );
    expect(
      lint(
        'for (const id of [1,2,3,4]) { const r = await tools.hubspot_api({method:"POST", path:"/crm/v3/objects/contacts/search", body:{query:id}}); text(r); }',
      ),
    ).toContain("Promise.all");
  });

  it.each([
    "let cursor; for (const id of [1,2,3,4]) { const r = await tools.catalog_get({cursor}); cursor = r.after; }",
    "const ids=[1,2,3,4]; let previous; for (const id of ids) { const r = await tools.catalog_get({id, previous}); previous = r; }",
    "for (const id of [1,2,3,4]) { const r = await tools.catalog_get({id}); if (r.done) break; }",
    "for (const id of [1,2,3,4]) { await tools.catalog_update({id}); }",
    "for (const id of [1,2,3,4]) { await tools.unknown_get({id}); }",
    'for (const id of [1,2,3,4]) { await tools.hubspot_api({method:"PATCH",path:"/crm/v3/objects/contacts/"+id}); }',
    'for (const id of [1,2,3,4]) { await tools.hubspot_api({method:"POST",path:"/crm/v3/objects/contacts"}); }',
    'const method = "PATCH"; for (const id of [1,2,3,4]) { await tools.hubspot_api({method, path:"/crm/v3/lists/"+id}); }',
    "for (const id of [1,2,3,4]) { const r = await tools.catalog_get({id}); await tools.catalog_update({id,r}); }",
    "for (const id of [1,2,3,4]) { const r = await tools.catalog_get({id}); mutate(r); }",
    "const state={get cursor(){return nextCursor();}}; for (const id of [1,2,3,4]) { const r=await tools.catalog_get({id,cursor:state.cursor}); text(r); }",
    "const state=unknownState(); for (const id of [1,2,3,4]) { const r=await tools.catalog_get({id,cursor:state.cursor}); text(r); }",
    "const out=[]; const alias=out; const again=alias; for (const id of [1,2,3,4]) { const r=await tools.catalog_get({id,previous:again}); out.push(r); }",
    "async function api(tools) {return await tools.catalog_get(tools);} for (const id of [1,2,3,4]) { const r=await api({id}); text(r); }",
    "async function api(args) {return await tools.catalog_get(args);} for (const api of [1,2,3,4]) { const r=await api({id:1}); text(r); }",
    "for (const id of [1,2,3]) { await tools.catalog_get({id}); }",
    "const ids=[1,2]; for (const id of ids) { await tools.catalog_get({id}); }",
    'const code = "for (const id of ids) await tools.catalog_get({id})"; // await tools.catalog_get({})',
    "for (const id of [1,2,3,4]) {",
  ])("leaves dependent, effectful and uncertain syntax alone: %s", (code) => {
    expect(lint(code)).toBeUndefined();
  });

  it("does not classify a wrapper with other effects as transparent", () => {
    expect(
      lint(
        "async function api(args) { await tools.catalog_update(args); return await tools.catalog_get(args); } for (const id of [1,2,3,4]) { const r=await api({id}); text(r); }",
      ),
    ).toBeUndefined();
  });

  it("does not infer effects from tool names alone", () => {
    expect(codemodeScriptLint("for (const id of [1,2,3,4]) { await tools.catalog_get({id}); }")).toBeUndefined();
  });
});
