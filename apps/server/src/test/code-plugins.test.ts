// Code plugins run in a worker: the bundle hash is checked, the plugin's
// own manifest must match the bundle, tools execute, and a hung or crashed
// plugin fails its call and comes back on the next one.

import { describe, expect, it } from "vitest";
import { loadCodePlugin } from "../integrations/code-plugins.js";
import { fixtureBundle, fixtureManifest, fixtureSource } from "./support/code-plugin-fixture.js";

const SECRETS: [string, string][] = [["token", "good"]];

describe("code plugins", () => {
  it("load from the bundle and run their tools in a worker", async () => {
    const { bytes, sha256 } = fixtureBundle("acme-run", "1.0.0");
    const connector = await loadCodePlugin(async () => bytes, sha256, "acme-run", "1.0.0");
    expect(connector.origin).toBe("registry");
    expect(connector.logo).toBe("<svg/>");
    expect(connector.secret_names).toEqual(["token"]);
    expect(connector.traits).toEqual({ web_search: "search" });
    expect((await connector.toolSpecs({})).map((t) => t.name)).toEqual(["echo", "search", "hang", "crash"]);
    await expect(connector.toolSpecs({ greeting: "invalid" })).rejects.toThrow(/greeting is invalid/);
    await connector.testConnection({}, SECRETS);
    await expect(connector.testConnection({}, [["token", "bad"]])).rejects.toThrow(/rejected the token/);
    const out = await connector.execute({ greeting: "yo" }, "echo", { text: "x" }, SECRETS, "a@b.test");
    expect(out.content).toBe("yo:x:a@b.test");
  });

  it("refuse bytes that do not match the approved hash", async () => {
    const { bytes } = fixtureBundle("acme-hash", "1.0.0");
    await expect(loadCodePlugin(async () => bytes, "0".repeat(64), "acme-hash", "1.0.0")).rejects.toThrow(
      /do not match the approved hash/,
    );
  });

  it("refuse a plugin.js whose manifest names another slug or version", async () => {
    const other = fixtureSource(fixtureManifest("someone-else", "1.0.0"));
    const a = fixtureBundle("acme-slug", "1.0.0", { source: other });
    await expect(loadCodePlugin(async () => a.bytes, a.sha256, "acme-slug", "1.0.0")).rejects.toThrow(
      /declares slug someone-else/,
    );
    const older = fixtureSource(fixtureManifest("acme-ver", "0.9.0"));
    const b = fixtureBundle("acme-ver", "1.0.0", { source: older });
    await expect(loadCodePlugin(async () => b.bytes, b.sha256, "acme-ver", "1.0.0")).rejects.toThrow(
      /declares version 0.9.0/,
    );
  });

  it("come back after a crash", async () => {
    const { bytes, sha256 } = fixtureBundle("acme-crash", "1.0.0");
    const connector = await loadCodePlugin(async () => bytes, sha256, "acme-crash", "1.0.0");
    await expect(connector.execute({}, "crash", {}, SECRETS, null)).rejects.toThrow(/exited/);
    const out = await connector.execute({}, "search", { query: "q" }, SECRETS, null);
    expect(out.content).toBe("results for q");
  });

  it("do not start when plugin.js throws at import", async () => {
    const { bytes, sha256 } = fixtureBundle("acme-broken", "1.0.0", { source: "throw new Error('boom at import');" });
    await expect(loadCodePlugin(async () => bytes, sha256, "acme-broken", "1.0.0")).rejects.toThrow(/boom at import/);
  });
});
