import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterAll, describe, expect, it, vi } from "vitest";
import { AgentGateway } from "../../platform/agentgateway.js";
import { delegatedIdentity } from "../../integrations/connector-mcp-identity.js";
import { installErrorHandling } from "../../platform/http/error.js";
import { registerMcpServiceTokenRoute } from "../../platform/http/mcp-service-token.js";
import type { IdentityCtx } from "../../platform/route-contexts.js";

const org = "00000000-0000-4000-8000-000000000001";
const member = { id: "00000000-0000-4000-8000-000000000002", org_id: org, email: "member@example.org" };
const issuer = "https://guild.example.org";
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const directory = mkdtempSync(join(tmpdir(), "guild-mcp-auth-"));
const servicesPath = join(directory, "services.json");
const delegatedKey = "test-delegation-service-key-for-mcp";
const headlessKey = "test-headless-service-key-for-mcp";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
writeFileSync(servicesPath, JSON.stringify([
  { id: "delegating", org, secretSha256: hash(delegatedKey), allowDelegation: true },
  { id: "headless", org, secretSha256: hash(headlessKey) },
]));

const app = Fastify();
installErrorHandling(app);
registerMcpServiceTokenRoute(app, {
  identity: { validateSession: vi.fn(async (token: string) => {
    if (token === "member") return member;
    return { ...member, org_id: "00000000-0000-4000-8000-000000000003" };
  }) },
  idpRecheck: { noteActivity: vi.fn() },
} as unknown as IdentityCtx, new AgentGateway({
  url: "https://mcp.example.org",
  issuer,
  signingKeyPath: "",
  signingKeyPem: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  mcpServicesPath: servicesPath,
}));

afterAll(async () => {
  await app.close();
  rmSync(directory, { recursive: true, force: true });
});

function request(service: string, secret: string, session?: string) {
  return app.inject({
    method: "POST",
    url: "/api/v1/mcp/service-token",
    headers: {
      "x-guild-mcp-service": service,
      "x-guild-mcp-service-key": secret,
      ...(session ? { authorization: `Bearer ${session}` } : {}),
      "x-guild-mcp-caller-email": "spoofed@example.org",
    },
  });
}

describe("MCP service token exchange", () => {
  it("keeps model traffic on Guild providers in MCP-only mode", () => {
    const config = {
      url: "https://mcp.example.org",
      issuer,
      signingKeyPath: "",
      signingKeyPem: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    };
    expect(new AgentGateway(config).routesModels).toBe(true);
    expect(new AgentGateway({ ...config, mcpOnly: true }).routesModels).toBe(false);
    expect(new AgentGateway({ ...config, serviceTokensOnly: true }).routesModels).toBe(false);
  });

  it("binds a service credential to its identity and org", async () => {
    expect((await request("headless", delegatedKey)).statusCode).toBe(401);
    const response = await request("headless", headlessKey);
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const { url, authorization } = response.json();
    expect(url).toBe(`https://mcp.example.org/mcp/${org}`);
    const payload = JSON.parse(Buffer.from(authorization.split(".")[1], "base64url").toString());
    expect(payload).toMatchObject({ sub: "service:headless", org, scope: "mcp" });
    expect(delegatedIdentity(authorization, keys.publicKey, issuer, org)).toBeNull();
  });

  it("requires an enabled service and an authenticated member of the same org for delegation", async () => {
    expect((await request("headless", headlessKey, "member")).statusCode).toBe(403);
    expect((await request("delegating", delegatedKey, "other-org")).statusCode).toBe(403);
    const response = await request("delegating", delegatedKey, "member");
    expect(response.statusCode).toBe(200);
    expect(delegatedIdentity(response.json().authorization, keys.publicKey, issuer, org)).toEqual({
      memberId: member.id, actingAs: member.email,
    });
  });
});
