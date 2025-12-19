# Interface: NormalizedChartData

Defined in: [packages/appkit-ui/src/react/charts/types.ts:216](https://github.com/databricks/appkit/blob/main/packages/appkit-ui/src/react/charts/types.ts#L216)

Normalized chart data for rendering (standard charts)

## Extends

- [`NormalizedChartDataBase`](NormalizedChartDataBase.md)

## Properties

### chartType

```ts
chartType: "timeseries" | "categorical";
```

Defined in: [packages/appkit-ui/src/react/charts/types.ts:212](https://github.com/databricks/appkit/blob/main/packages/appkit-ui/src/react/charts/types.ts#L212)

#### Inherited from

[`NormalizedChartDataBase`](NormalizedChartDataBase.md).[`chartType`](NormalizedChartDataBase.md#charttype)

***

### xData

```ts
xData: (string | number)[];
```

Defined in: [packages/appkit-ui/src/react/charts/types.ts:209](https://github.com/databricks/appkit/blob/main/packages/appkit-ui/src/react/charts/types.ts#L209)

#### Inherited from

[`NormalizedChartDataBase`](NormalizedChartDataBase.md).[`xData`](NormalizedChartDataBase.md#xdata)

***

### xField

```ts
xField: string;
```

Defined in: [packages/appkit-ui/src/react/charts/types.ts:210](https://github.com/databricks/appkit/blob/main/packages/appkit-ui/src/react/charts/types.ts#L210)

#### Inherited from

[`NormalizedChartDataBase`](NormalizedChartDataBase.md).[`xField`](NormalizedChartDataBase.md#xfield)

***

### yDataMap

```ts
yDataMap: Record<string, (string | number)[]>;
```

Defined in: [packages/appkit-ui/src/react/charts/types.ts:217](https://github.com/databricks/appkit/blob/main/packages/appkit-ui/src/react/charts/types.ts#L217)

***

### yFields

```ts
yFields: string[];
```

Defined in: [packages/appkit-ui/src/react/charts/types.ts:211](https://github.com/databricks/appkit/blob/main/packages/appkit-ui/src/react/charts/types.ts#L211)

#### Inherited from

[`NormalizedChartDataBase`](NormalizedChartDataBase.md).[`yFields`](NormalizedChartDataBase.md#yfields)
