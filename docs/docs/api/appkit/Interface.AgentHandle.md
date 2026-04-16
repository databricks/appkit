# Interface: AgentHandle

## Properties

### addTools()

```ts
addTools: (tools: FunctionTool[]) => void;
```

Add function tools at runtime (HostedTools must be configured at setup).

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `tools` | [`FunctionTool`](Interface.FunctionTool.md)[] |

#### Returns

`void`

***

### getThreads()

```ts
getThreads: (userId: string) => Promise<unknown>;
```

List threads for a user.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `userId` | `string` |

#### Returns

`Promise`\<`unknown`\>

***

### getTools()

```ts
getTools: () => AgentToolDefinition[];
```

Get all tool definitions available to agents.

#### Returns

[`AgentToolDefinition`](Interface.AgentToolDefinition.md)[]

***

### plugins

```ts
plugins: Record<string, any>;
```

Access to user-provided plugin APIs.

***

### registerAgent()

```ts
registerAgent: (name: string, adapter: AgentAdapter) => void;
```

Register an additional agent at runtime.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `name` | `string` |
| `adapter` | [`AgentAdapter`](Interface.AgentAdapter.md) |

#### Returns

`void`
