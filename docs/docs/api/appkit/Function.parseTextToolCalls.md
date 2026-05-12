# Function: parseTextToolCalls()

```ts
function parseTextToolCalls(text: string): {
  args: unknown;
  name: string;
}[];
```

Parses text-based tool calls from model output.

Handles two formats:
1. Llama native: `[{"name": "tool_name", "parameters": {"arg": "val"}}]`
2. Python-style: `[tool_name(arg1='val1', arg2='val2')]`

## Parameters

| Parameter | Type |
| ------ | ------ |
| `text` | `string` |

## Returns

\{
  `args`: `unknown`;
  `name`: `string`;
\}[]
