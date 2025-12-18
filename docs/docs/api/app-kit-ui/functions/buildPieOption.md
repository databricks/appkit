# Function: buildPieOption()

```ts
function buildPieOption(
   ctx, 
   chartType, 
   innerRadius, 
   showLabels, 
labelPosition): Record<string, unknown>;
```

Defined in: [packages/app-kit-ui/src/react/charts/options.ts:79](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/options.ts#L79)

## Parameters

| Parameter | Type |
| ------ | ------ |
| `ctx` | [`OptionBuilderContext`](../interfaces/OptionBuilderContext.md) |
| `chartType` | `"pie"` \| `"donut"` |
| `innerRadius` | `number` |
| `showLabels` | `boolean` |
| `labelPosition` | `string` |

## Returns

`Record`\<`string`, `unknown`\>
