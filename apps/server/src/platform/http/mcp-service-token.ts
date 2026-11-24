import type { FastifyInstance } from "fastify";
import type { AgentGateway } from "../agentgateway.js";
import { ApiError } from "../errors.js";
import type { IdentityCtx } from "../route-contexts.js";
import { requireUser } from "./error.js";

export function registerMcpServiceTokenRoute(app: FastifyInstance, auth: IdentityCtx, gateway: AgentGateway | null): void {
  if (!gateway) return;
  app.post("/api/v1/mcp/service-token", async (req, reply) => {
    const id = req.headers["x-guild-mcp-service"];
    const credential = req.headers["x-guild-mcp-service-key"];
    const service = typeof id === "string" && typeof credential === "string"
      ? gateway.authenticateMcpService(id, credential)
      : undefined;
    if (!service) throw ApiError.unauthorized("invalid MCP service credential");
    const member = req.headers.authorization === undefined ? undefined : await requireUser(auth, req);
    if (member && (!service.allowDelegation || member.org_id !== service.org)) {
      throw ApiError.forbidden("MCP service cannot act for this member");
    }
    reply.header("cache-control", "no-store");
    return gateway.serviceMcp(service, member);
  });
}
