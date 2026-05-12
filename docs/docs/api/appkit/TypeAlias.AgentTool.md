# Type Alias: AgentTool

```ts
type AgentTool = 
  | FunctionTool
  | HostedTool
  | ToolkitEntry;
```

Any tool an agent can invoke: inline function tools (`tool()`), hosted MCP
tools (`mcpServer()` / raw hosted), or toolkit references from plugins
(`analytics().toolkit()`).
