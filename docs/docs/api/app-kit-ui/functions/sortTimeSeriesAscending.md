# Function: sortTimeSeriesAscending()

```ts
function sortTimeSeriesAscending(
   xData, 
   yDataMap, 
   yFields): object;
```

Defined in: [packages/app-kit-ui/src/react/charts/utils.ts:83](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/utils.ts#L83)

Sorts time-series data in ascending chronological order.

## Parameters

| Parameter | Type |
| ------ | ------ |
| `xData` | (`string` \| `number`)[] |
| `yDataMap` | `Record`\<`string`, (`string` \| `number`)[]\> |
| `yFields` | `string`[] |

## Returns

`object`

### xData

```ts
xData: (string | number)[];
```

### yDataMap

```ts
yDataMap: Record<string, (string | number)[]>;
```
