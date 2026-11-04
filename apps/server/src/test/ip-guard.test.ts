// The shared outbound-address classifier.

import { describe, expect, it } from "vitest";
import { isNonPublicAddress } from "@guild/integration-sdk";
import { validateUrl } from "../integrations/mcp-url.js";

describe("isNonPublicAddress", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "0.0.0.0",
    "100.64.0.1",
    "198.18.0.1",
    "224.0.0.1",
    "::1",
    "::",
    "fe80::1",
    "fd00::1",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "[::ffff:a9fe:a9fe]",
  ])("refuses %s", (address) => {
    expect(isNonPublicAddress(address)).toBe(true);
  });

  it.each(["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "::ffff:808:808", "example.org"])("allows %s", (address) => {
    expect(isNonPublicAddress(address)).toBe(false);
  });
});

describe("user MCP URL guard", () => {
  it("refuses an IPv4-mapped loopback in hex form", async () => {
    await expect(validateUrl("http://[::ffff:7f00:1]:8080/mcp")).rejects.toThrow(/private/);
  });
});
