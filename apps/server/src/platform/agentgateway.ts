import { createHash, createPrivateKey, sign, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";

export interface AgentGatewayConfig {
  url: string;
  issuer: string;
  signingKeyPath: string;
  signingKeyPem?: string;
  mcpServicesPath?: string;
  serviceTokensOnly?: boolean;
}

const audience = "guild-agentgateway";
const keyId = "guild-workload";
const serviceName = /^[a-z][a-z0-9-]{0,62}$/;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

interface McpService {
  id: string;
  org: string;
  secretSha256: string;
  allowDelegation?: boolean;
}

interface McpDelegate {
  id: string;
  org_id: string;
  email: string;
}

function base64Json(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export class AgentGateway {
  private readonly signingKey;
  private readonly services = new Map<string, McpService>();
  private readonly tokenHeader = base64Json({ alg: "RS256", typ: "JWT", kid: keyId });

  constructor(private readonly config: AgentGatewayConfig) {
    this.signingKey = createPrivateKey(config.signingKeyPem ?? readFileSync(config.signingKeyPath));
    if (this.signingKey.asymmetricKeyType !== "rsa" || (this.signingKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) {
      throw new Error("Agentgateway signing key must be RSA with at least 2048 bits");
    }
    if (config.mcpServicesPath) {
      const services = JSON.parse(readFileSync(config.mcpServicesPath, "utf8")) as McpService[];
      const hashes = new Set<string>();
      if (!Array.isArray(services)) throw new Error("MCP service identities must be an array");
      for (const service of services) {
        if (!service || typeof service.id !== "string" || typeof service.org !== "string" ||
            !serviceName.test(service.id) || !uuid.test(service.org) || !/^[0-9a-f]{64}$/.test(service.secretSha256) ||
            this.services.has(service.id) || hashes.has(service.secretSha256) ||
            (service.allowDelegation !== undefined && typeof service.allowDelegation !== "boolean")) {
          throw new Error("invalid or duplicate agentgateway MCP service identity");
        }
        this.services.set(service.id, service);
        hashes.add(service.secretSha256);
      }
    }
  }

  model(orgId: string, model: string, protocol: string): { baseUrl: string; authorization: string } {
    const routeId = createHash("sha256").update(model).digest("hex").slice(0, 32);
    return {
      baseUrl: `${this.config.url}/llm/${encodeURIComponent(orgId)}/${protocol}/${routeId}`,
      authorization: this.authorize({ sub: `org:${orgId}`, scope: "llm", org: orgId, model }),
    };
  }

  mcp(orgId: string, memberId: string, actingAs?: string | null, chatId?: string): { url: string; headers: Record<string, string> } {
    return {
      url: `${this.config.url}/mcp/${encodeURIComponent(orgId)}`,
      headers: { authorization: this.authorize({
        sub: memberId, scope: "mcp", org: orgId,
        ...(actingAs ? { acting_as: actingAs } : {}),
        ...(chatId ? { chat: chatId } : {}),
      }) },
    };
  }

  authenticateMcpService(id: string, secret: string): McpService | undefined {
    const service = this.services.get(id);
    if (!service || secret.length < 32 || secret.length > 512) return undefined;
    const supplied = createHash("sha256").update(secret).digest();
    return timingSafeEqual(supplied, Buffer.from(service.secretSha256, "hex")) ? service : undefined;
  }

  serviceMcp(service: McpService, member?: McpDelegate): { url: string; authorization: string } {
    if (member && (!service.allowDelegation || member.org_id !== service.org)) {
      throw new Error("invalid MCP service delegation");
    }
    return {
      url: `${this.config.url}/mcp/${encodeURIComponent(service.org)}`,
      authorization: this.authorize({
        sub: `service:${service.id}`, scope: "mcp", org: service.org,
        ...(member ? { delegated_member: member.id, acting_as: member.email } : {}),
      }),
    };
  }

  private authorize(claims: { sub: string; scope: "llm" | "mcp"; org: string; model?: string; acting_as?: string; chat?: string; delegated_member?: string }): string {
    const issuedAt = Math.floor(Date.now() / 1000);
    const payload = base64Json({
      ...claims,
      iss: this.config.issuer,
      aud: audience,
      iat: issuedAt,
      exp: issuedAt + 90,
    });
    const input = `${this.tokenHeader}.${payload}`;
    const signature = sign("RSA-SHA256", Buffer.from(input), this.signingKey).toString("base64url");
    return `Bearer ${input}.${signature}`;
  }
}
