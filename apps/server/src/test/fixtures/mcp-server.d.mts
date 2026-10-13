// Types for the fixture MCP server (plain .mjs, imported from the TS tests).
import type { Server } from "node:http";

export function startMcpFixtureServer(port?: number, host?: string): Promise<Server>;
