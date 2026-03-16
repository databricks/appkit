# Class: StandardAgent

Contract that agent implementations must fulfil.

The plugin calls `invoke()` for non-streaming requests and `stream()` for
SSE streaming. Implementations are responsible for translating their SDK's
output into Responses API types.

## Implements

- [`AgentInterface`](Interface.AgentInterface.md)

## Constructors

### Constructor

```ts
new StandardAgent(agent: LangGraphAgent, systemPrompt: string): StandardAgent;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `agent` | `LangGraphAgent` |
| `systemPrompt` | `string` |

#### Returns

`StandardAgent`

## Methods

### invoke()

```ts
invoke(params: InvokeParams): Promise<ResponseOutputItem[]>;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `params` | [`InvokeParams`](Interface.InvokeParams.md) |

#### Returns

`Promise`\<[`ResponseOutputItem`](TypeAlias.ResponseOutputItem.md)[]\>

#### Implementation of

[`AgentInterface`](Interface.AgentInterface.md).[`invoke`](Interface.AgentInterface.md#invoke)

***

### stream()

```ts
stream(params: InvokeParams): AsyncGenerator<ResponseStreamEvent>;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `params` | [`InvokeParams`](Interface.InvokeParams.md) |

#### Returns

`AsyncGenerator`\<[`ResponseStreamEvent`](TypeAlias.ResponseStreamEvent.md)\>

#### Implementation of

[`AgentInterface`](Interface.AgentInterface.md).[`stream`](Interface.AgentInterface.md#stream)
