/**
 * Input shape consumed by {@link AppKitMcpClient.connect}. Produced by the
 * agents plugin from user-facing `HostedTool` declarations (see
 * `plugins/agents/tools/hosted-tools.ts`) and accepted directly by the
 * connector to keep its surface free of agent-layer concepts.
 */
export interface McpEndpointConfig {
  /** Stable logical name used as the `mcp.<name>.*` tool prefix and in logs. */
  name: string;
  /** Absolute URL (`https://…`) or workspace-relative path (`/api/2.0/mcp/…`). */
  url: string;
}
