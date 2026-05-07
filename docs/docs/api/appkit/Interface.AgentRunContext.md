# Interface: AgentRunContext

## Properties

### executeTool()

```ts
executeTool: (name: string, args: unknown) => Promise<unknown>;
```

Tool implementations should sanitize failure text — errors become `tool_result.error` and can flow back into the LLM transcript.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `name` | `string` |
| `args` | `unknown` |

#### Returns

`Promise`\<`unknown`\>

***

### signal?

```ts
optional signal: AbortSignal;
```
