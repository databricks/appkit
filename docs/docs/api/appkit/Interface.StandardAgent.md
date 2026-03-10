# Interface: StandardAgent

Built-in [AgentInterface](Interface.AgentInterface.md) implementation that wraps a LangGraph
`createReactAgent` and translates its stream events into Responses API
SSE format. Use this as the default agent unless you need a custom
implementation for a different LLM SDK.

## Implements

- [`AgentInterface`](Interface.AgentInterface.md)

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

`Promise`\<`ResponseOutputItem`[]\>

#### Implementation of

```ts
AgentInterface.invoke
```

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

```ts
AgentInterface.stream
```
