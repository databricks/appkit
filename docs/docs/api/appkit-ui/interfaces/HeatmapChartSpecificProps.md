# Interface: HeatmapChartSpecificProps

Defined in: [packages/appkit-ui/src/react/charts/types.ts:173](https://github.com/databricks/appkit/blob/main/packages/appkit-ui/src/react/charts/types.ts#L173)

Props specific to heatmap charts

## Properties

### max?

```ts
optional max: number;
```

Defined in: [packages/appkit-ui/src/react/charts/types.ts:182](https://github.com/databricks/appkit/blob/main/packages/appkit-ui/src/react/charts/types.ts#L182)

Max value for color scale (auto-detected if not provided)

***

### min?

```ts
optional min: number;
```

Defined in: [packages/appkit-ui/src/react/charts/types.ts:180](https://github.com/databricks/appkit/blob/main/packages/appkit-ui/src/react/charts/types.ts#L180)

Min value for color scale (auto-detected if not provided)

***

### showLabels?

```ts
optional showLabels: boolean;
```

Defined in: [packages/appkit-ui/src/react/charts/types.ts:184](https://github.com/databricks/appkit/blob/main/packages/appkit-ui/src/react/charts/types.ts#L184)

Show value labels on cells

#### Default

```ts
false
```

***

### yAxisKey?

```ts
optional yAxisKey: string;
```

Defined in: [packages/appkit-ui/src/react/charts/types.ts:178](https://github.com/databricks/appkit/blob/main/packages/appkit-ui/src/react/charts/types.ts#L178)

Field key for the Y-axis categories.
For heatmaps, data should have: xKey (column), yAxisKey (row), and yKey (value).
