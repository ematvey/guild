/** Unambiguous call identity shared by discovery responses and execution. */
export function userMcpToolName(serverName: string, toolName: string): string {
  return `mcp${serverName.length}_${serverName}_${toolName}`;
}
