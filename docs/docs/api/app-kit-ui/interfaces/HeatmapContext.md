# Interface: HeatmapContext

Defined in: [packages/app-kit-ui/src/react/charts/options.ts:167](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/options.ts#L167)

## Extends

- [`OptionBuilderContext`](OptionBuilderContext.md)

## Properties

### colors

```ts
colors: string[];
```

Defined in: [packages/app-kit-ui/src/react/charts/options.ts:12](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/options.ts#L12)

#### Inherited from

[`OptionBuilderContext`](OptionBuilderContext.md).[`colors`](OptionBuilderContext.md#colors)

***

### heatmapData

```ts
heatmapData: [number, number, number][];
```

Defined in: [packages/app-kit-ui/src/react/charts/options.ts:171](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/options.ts#L171)

Heatmap data as [xIndex, yIndex, value] tuples

***

### max

```ts
max: number;
```

Defined in: [packages/app-kit-ui/src/react/charts/options.ts:175](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/options.ts#L175)

Max value for color scale

***

### min

```ts
min: number;
```

Defined in: [packages/app-kit-ui/src/react/charts/options.ts:173](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/options.ts#L173)

Min value for color scale

***

### showLabels

```ts
showLabels: boolean;
```

Defined in: [packages/app-kit-ui/src/react/charts/options.ts:177](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/options.ts#L177)

Show value labels on cells

***

### showLegend

```ts
showLegend: boolean;
```

Defined in: [packages/app-kit-ui/src/react/charts/options.ts:14](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/options.ts#L14)

#### Inherited from

[`OptionBuilderContext`](OptionBuilderContext.md).[`showLegend`](OptionBuilderContext.md#showlegend)

***

### title?

```ts
optional title: string;
```

Defined in: [packages/app-kit-ui/src/react/charts/options.ts:13](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/options.ts#L13)

#### Inherited from

[`OptionBuilderContext`](OptionBuilderContext.md).[`title`](OptionBuilderContext.md#title)

***

### xData

```ts
xData: (string | number)[];
```

Defined in: [packages/app-kit-ui/src/react/charts/options.ts:9](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/options.ts#L9)

#### Inherited from

[`OptionBuilderContext`](OptionBuilderContext.md).[`xData`](OptionBuilderContext.md#xdata)

***

### yAxisData

```ts
yAxisData: (string | number)[];
```

Defined in: [packages/app-kit-ui/src/react/charts/options.ts:169](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/options.ts#L169)

Y-axis categories (rows)

***

### yDataMap

```ts
yDataMap: Record<string, (string | number)[]>;
```

Defined in: [packages/app-kit-ui/src/react/charts/options.ts:10](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/options.ts#L10)

#### Inherited from

[`OptionBuilderContext`](OptionBuilderContext.md).[`yDataMap`](OptionBuilderContext.md#ydatamap)

***

### yFields

```ts
yFields: string[];
```

Defined in: [packages/app-kit-ui/src/react/charts/options.ts:11](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/options.ts#L11)

#### Inherited from

[`OptionBuilderContext`](OptionBuilderContext.md).[`yFields`](OptionBuilderContext.md#yfields)
