# Type Alias: AgentTool

```ts
type AgentTool = 
  | FunctionTool
  | HostedTool
  | ToolkitEntry
  | HostedSupervisorTool;
```

Any tool an agent can invoke: inline function tools (`tool()`), hosted MCP
tools (`mcpServer()` / raw hosted), toolkit references from plugins
(`analytics().toolkit()`), or adapter-hosted Supervisor-API tools
(`supervisorTools.*`).
