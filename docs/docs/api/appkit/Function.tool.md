# Function: tool()

```ts
function tool<S>(config: ToolConfig<S>): FunctionTool;
```

Factory for defining function tools with Zod schemas.

- Generates JSON Schema (for the LLM) from the Zod schema via `z.toJSONSchema()`.
- Infers the `execute` argument type from the schema.
- Validates tool call arguments at runtime. On validation failure, returns
  a formatted error string to the LLM instead of throwing, so the model
  can self-correct on its next turn.

## Type Parameters

| Type Parameter |
| ------ |
| `S` *extends* `ZodType`\<`unknown`, `unknown`, `$ZodTypeInternals`\<`unknown`, `unknown`\>\> |

## Parameters

| Parameter | Type |
| ------ | ------ |
| `config` | [`ToolConfig`](Interface.ToolConfig.md)\<`S`\> |

## Returns

[`FunctionTool`](Interface.FunctionTool.md)
