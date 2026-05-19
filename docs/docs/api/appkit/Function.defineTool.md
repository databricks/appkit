# Function: defineTool()

```ts
function defineTool<S>(config: ToolEntry<S>): ToolEntry<S>;
```

Defines a single tool entry for a plugin's internal registry.

The generic `S` flows from `schema` through to the `handler` callback so
`args` is fully typed from the Zod schema. Names are assigned by the
registry key, so they are not repeated inside the entry.

## Type Parameters

| Type Parameter |
| ------ |
| `S` *extends* `ZodType`\<`unknown`, `unknown`, `$ZodTypeInternals`\<`unknown`, `unknown`\>\> |

## Parameters

| Parameter | Type |
| ------ | ------ |
| `config` | [`ToolEntry`](Interface.ToolEntry.md)\<`S`\> |

## Returns

[`ToolEntry`](Interface.ToolEntry.md)\<`S`\>
