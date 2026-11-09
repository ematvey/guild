// App data functions and the App page: the manifest parser, argument
// binding, the bridge injection and the page policy.

import { describe, expect, it } from "vitest";
import { AppFunctionError, bindAppFunction, parseAppFunctions } from "../platform/domain/app-functions.js";
import { APP_BRIDGE, APP_CSP, injectBridge } from "../platform/http/apps.js";

const [fn] = parseAppFunctions([
  {
    name: "deals",
    description: "Deals in a stage",
    integration: "hubspot",
    tool: "hubspot_search_deals",
    args: { filters: [{ stage: { $param: "stage" } }, { owner: { $param: "owner" } }], limit: { $param: "limit" } },
    params: {
      stage: { type: "string", enum: ["open", "won"], default: "open" },
      owner: { type: "string", max_length: 40 },
      limit: { type: "integer", minimum: 1, maximum: 100, required: true },
    },
  },
]);

describe("parseAppFunctions", () => {
  it("refuses an argument hole with no declared parameter", () => {
    expect(() =>
      parseAppFunctions([{ name: "x", integration: "a", tool: "b", args: { q: { $param: "q" } }, params: {} }]),
    ).toThrow(/undeclared parameter "q"/);
  });

  it("refuses bad names, duplicate functions and bad defaults", () => {
    expect(() => parseAppFunctions([{ name: "Bad Name", integration: "a", tool: "b" }])).toThrow(AppFunctionError);
    expect(() =>
      parseAppFunctions([
        { name: "x", integration: "a", tool: "b" },
        { name: "x", integration: "a", tool: "b" },
      ]),
    ).toThrow(/declared twice/);
    expect(() =>
      parseAppFunctions([
        { name: "x", integration: "a", tool: "b", params: { p: { type: "string", enum: ["a"], default: "z" } } },
      ]),
    ).toThrow(/must be one of/);
  });
});

describe("bindAppFunction", () => {
  it("fills holes, applies defaults and drops omitted optional ones", () => {
    expect(bindAppFunction(fn!, { limit: 5 })).toEqual({ filters: [{ stage: "open" }, {}], limit: 5 });
    expect(bindAppFunction(fn!, { limit: 5, stage: "won", owner: "ada" })).toEqual({
      filters: [{ stage: "won" }, { owner: "ada" }],
      limit: 5,
    });
  });

  it("refuses values outside the declared bounds", () => {
    expect(() => bindAppFunction(fn!, {})).toThrow(/required/);
    expect(() => bindAppFunction(fn!, { limit: 0 })).toThrow(/at least 1/);
    expect(() => bindAppFunction(fn!, { limit: 1.5 })).toThrow(/integer/);
    expect(() => bindAppFunction(fn!, { limit: 1, stage: "lost" })).toThrow(/one of/);
    expect(() => bindAppFunction(fn!, { limit: 1, owner: "x".repeat(41) })).toThrow(/longer/);
    expect(() => bindAppFunction(fn!, { limit: 1, tool: "other" })).toThrow(/no parameter "tool"/);
    expect(() => bindAppFunction(fn!, { limit: "1" })).toThrow(/number/);
  });

  it("never lets a value become an argument key or a new hole", () => {
    const bound = bindAppFunction(fn!, { limit: 1, owner: '{"$param":"stage"}' });
    expect(bound).toEqual({ filters: [{ stage: "open" }, { owner: '{"$param":"stage"}' }], limit: 1 });
  });
});

describe("injectBridge", () => {
  it("places the bridge after <head>, keeping the doctype first", () => {
    const html = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"></head><body></body></html>';
    expect(injectBridge(html)).toBe(
      `<!DOCTYPE html><html lang="en"><head>${APP_BRIDGE}<meta charset="utf-8"></head><body></body></html>`,
    );
  });

  it("falls back to after <html>, after the doctype, or the top", () => {
    expect(injectBridge("<html><body></body></html>")).toBe(`<html>${APP_BRIDGE}<body></body></html>`);
    expect(injectBridge("<!doctype html><p>x</p>")).toBe(`<!doctype html>${APP_BRIDGE}<p>x</p>`);
    expect(injectBridge("<p>x</p>")).toBe(`${APP_BRIDGE}<p>x</p>`);
  });
});

describe("APP_CSP", () => {
  it("leaves the page no network channel of its own", () => {
    expect(APP_CSP).toContain("connect-src 'none'");
    expect(APP_CSP).toContain("img-src data: blob:");
    expect(APP_CSP).toContain("form-action 'none'");
    expect(APP_CSP).not.toContain("allow-popups");
    expect(APP_CSP).not.toContain("allow-same-origin");
    expect(APP_CSP).not.toContain("allow-top-navigation");
  });
});
