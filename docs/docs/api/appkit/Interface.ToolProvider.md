# Interface: ToolProvider

## Methods

### executeAgentTool()

```ts
executeAgentTool(
   name: string, 
   args: unknown, 
signal?: AbortSignal): Promise<unknown>;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `name` | `string` |
| `args` | `unknown` |
| `signal?` | `AbortSignal` |

#### Returns

`Promise`\<`unknown`\>

***

### getAgentTools()

```ts
getAgentTools(): AgentToolDefinition[];
```

#### Returns

[`AgentToolDefinition`](Interface.AgentToolDefinition.md)[]
