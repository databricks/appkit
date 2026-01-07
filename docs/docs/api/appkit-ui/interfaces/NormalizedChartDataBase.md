# Interface: NormalizedChartDataBase

Defined in: [packages/appkit-ui/src/react/charts/types.ts:208](https://github.com/databricks/appkit/blob/main/packages/appkit-ui/src/react/charts/types.ts#L208)

Base normalized data shared by all chart types

## Extended by

- [`NormalizedHeatmapData`](NormalizedHeatmapData.md)
- [`NormalizedChartData`](NormalizedChartData.md)

## Properties

### chartType

```ts
chartType: "timeseries" | "categorical";
```

Defined in: [packages/appkit-ui/src/react/charts/types.ts:212](https://github.com/databricks/appkit/blob/main/packages/appkit-ui/src/react/charts/types.ts#L212)

***

### xData

```ts
xData: (string | number)[];
```

Defined in: [packages/appkit-ui/src/react/charts/types.ts:209](https://github.com/databricks/appkit/blob/main/packages/appkit-ui/src/react/charts/types.ts#L209)

***

### xField

```ts
xField: string;
```

Defined in: [packages/appkit-ui/src/react/charts/types.ts:210](https://github.com/databricks/appkit/blob/main/packages/appkit-ui/src/react/charts/types.ts#L210)

***

### yFields

```ts
yFields: string[];
```

Defined in: [packages/appkit-ui/src/react/charts/types.ts:211](https://github.com/databricks/appkit/blob/main/packages/appkit-ui/src/react/charts/types.ts#L211)
