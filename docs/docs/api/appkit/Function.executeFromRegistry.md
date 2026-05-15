# Function: executeFromRegistry()

```ts
function executeFromRegistry(
   registry: ToolRegistry, 
   name: string, 
   args: unknown, 
signal?: AbortSignal): Promise<unknown>;
```

Validates tool-call arguments against the entry's schema and invokes its
handler. On validation failure, returns an LLM-friendly error string
(matching the behavior of `tool()`) rather than throwing, so the model
can self-correct on its next turn.

## Parameters

| Parameter | Type |
| ------ | ------ |
| `registry` | [`ToolRegistry`](TypeAlias.ToolRegistry.md) |
| `name` | `string` |
| `args` | `unknown` |
| `signal?` | `AbortSignal` |

## Returns

`Promise`\<`unknown`\>
