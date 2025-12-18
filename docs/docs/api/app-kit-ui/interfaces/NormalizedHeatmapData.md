# Interface: NormalizedHeatmapData

Defined in: [packages/app-kit-ui/src/react/charts/normalize.ts:306](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/normalize.ts#L306)

Normalized data for heatmap charts.
Extends base (not NormalizedChartData) because heatmaps don't use yDataMap.
Instead, they use heatmapData which contains [xIndex, yIndex, value] tuples.

## Extends

- [`NormalizedChartDataBase`](NormalizedChartDataBase.md)

## Properties

### chartType

```ts
chartType: "timeseries" | "categorical";
```

Defined in: [packages/app-kit-ui/src/react/charts/types.ts:212](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/types.ts#L212)

#### Inherited from

[`NormalizedChartDataBase`](NormalizedChartDataBase.md).[`chartType`](NormalizedChartDataBase.md#charttype)

***

### heatmapData

```ts
heatmapData: [number, number, number][];
```

Defined in: [packages/app-kit-ui/src/react/charts/normalize.ts:310](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/normalize.ts#L310)

Heatmap data as [xIndex, yIndex, value] tuples

***

### max

```ts
max: number;
```

Defined in: [packages/app-kit-ui/src/react/charts/normalize.ts:314](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/normalize.ts#L314)

Max value in the data

***

### min

```ts
min: number;
```

Defined in: [packages/app-kit-ui/src/react/charts/normalize.ts:312](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/normalize.ts#L312)

Min value in the data

***

### xData

```ts
xData: (string | number)[];
```

Defined in: [packages/app-kit-ui/src/react/charts/types.ts:209](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/types.ts#L209)

#### Inherited from

[`NormalizedChartDataBase`](NormalizedChartDataBase.md).[`xData`](NormalizedChartDataBase.md#xdata)

***

### xField

```ts
xField: string;
```

Defined in: [packages/app-kit-ui/src/react/charts/types.ts:210](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/types.ts#L210)

#### Inherited from

[`NormalizedChartDataBase`](NormalizedChartDataBase.md).[`xField`](NormalizedChartDataBase.md#xfield)

***

### yAxisData

```ts
yAxisData: (string | number)[];
```

Defined in: [packages/app-kit-ui/src/react/charts/normalize.ts:308](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/normalize.ts#L308)

Y-axis categories (rows)

***

### yFields

```ts
yFields: string[];
```

Defined in: [packages/app-kit-ui/src/react/charts/types.ts:211](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/types.ts#L211)

#### Inherited from

[`NormalizedChartDataBase`](NormalizedChartDataBase.md).[`yFields`](NormalizedChartDataBase.md#yfields)
