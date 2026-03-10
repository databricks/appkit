# Interface: StandardAgent

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
