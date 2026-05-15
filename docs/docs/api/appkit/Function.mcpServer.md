# Function: mcpServer()

```ts
function mcpServer(name: string, url: string): CustomMcpServerTool;
```

Factory for declaring a custom MCP server tool.

Replaces the verbose `{ type: "custom_mcp_server", custom_mcp_server: { app_name, app_url } }`
wrapper with a concise positional call.

Example:
```ts
mcpServer("my-app", "https://my-app.databricksapps.com/mcp")
```

## Parameters

| Parameter | Type |
| ------ | ------ |
| `name` | `string` |
| `url` | `string` |

## Returns

`CustomMcpServerTool`
