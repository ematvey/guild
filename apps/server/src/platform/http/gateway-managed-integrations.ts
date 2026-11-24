import { ApiError } from "../errors.js";

/** The Kubernetes gateway deployment edits integration inventory as resources. */
export function requireLocalIntegrationManagement(gateway: unknown): void {
  if (gateway) {
    throw ApiError.conflict(
      "integration_managed_by_agentgateway",
      "This deployment manages integration connections and tool access in agentgateway.",
    );
  }
}
