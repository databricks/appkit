# Interface: AgentInterface

Contract that agent implementations must fulfil.

The plugin calls `invoke()` for non-streaming requests and `stream()` for
SSE streaming. Implementations are responsible for translating their SDK's
output into Responses API types.

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
