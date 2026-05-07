# Function: toolsFromRegistry()

```ts
function toolsFromRegistry(registry: ToolRegistry): AgentToolDefinition[];
```

Produces the `AgentToolDefinition[]` a ToolProvider exposes to the LLM,
deriving `parameters` JSON Schema from each entry's Zod schema.

Tool names come from registry keys (supports dotted names like
`uploads.list` for dynamic plugins).

## Parameters

| Parameter | Type |
| ------ | ------ |
| `registry` | [`ToolRegistry`](TypeAlias.ToolRegistry.md) |

## Returns

[`AgentToolDefinition`](Interface.AgentToolDefinition.md)[]
