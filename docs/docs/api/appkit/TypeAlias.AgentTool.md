# Type Alias: AgentTool

```ts
type AgentTool = 
  | FunctionTool
  | HostedTool;
```

A tool that can be registered with the agent plugin.

- `FunctionTool`: OpenResponses-aligned plain object with JSON Schema parameters and an execute handler.
- `HostedTool`: Databricks-hosted tool (genie, vector_search_index, custom_mcp_server, external_mcp_server).
