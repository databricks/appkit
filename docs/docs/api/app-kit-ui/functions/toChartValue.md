# Function: toChartValue()

```ts
function toChartValue(value): string | number;
```

Defined in: [packages/app-kit-ui/src/react/charts/utils.ts:10](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/utils.ts#L10)

Converts a value to a chart-compatible type.
Handles BigInt conversion (Arrow can return BigInt64Array values).
Handles Date objects by converting to timestamps.

## Parameters

| Parameter | Type |
| ------ | ------ |
| `value` | `unknown` |

## Returns

`string` \| `number`
