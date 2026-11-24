import { createHash, createPrivateKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";

export interface AgentGatewayConfig {
  url: string;
  issuer: string;
  signingKeyPath: string;
  signingKeyPem?: string;
}

const audience = "guild-agentgateway";
const keyId = "guild-workload";

function base64Json(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export class AgentGateway {
  private readonly signingKey;
  private readonly tokenHeader = base64Json({ alg: "RS256", typ: "JWT", kid: keyId });

  constructor(private readonly config: AgentGatewayConfig) {
    this.signingKey = createPrivateKey(config.signingKeyPem ?? readFileSync(config.signingKeyPath));
    if (this.signingKey.asymmetricKeyType !== "rsa" || (this.signingKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) {
      throw new Error("Agentgateway signing key must be RSA with at least 2048 bits");
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

  private authorize(claims: { sub: string; scope: "llm" | "mcp"; org: string; model?: string; acting_as?: string; chat?: string }): string {
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
