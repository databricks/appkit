# Interface: AgentAdapter

## Methods

### run()

```ts
run(input: AgentInput, context: AgentRunContext): AsyncGenerator<AgentEvent, void, unknown>;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `input` | [`AgentInput`](Interface.AgentInput.md) |
| `context` | [`AgentRunContext`](Interface.AgentRunContext.md) |

#### Returns

`AsyncGenerator`\<[`AgentEvent`](TypeAlias.AgentEvent.md), `void`, `unknown`\>
