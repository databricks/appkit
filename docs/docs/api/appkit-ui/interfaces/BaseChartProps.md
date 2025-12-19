# Interface: BaseChartProps

Defined in: [packages/appkit-ui/src/react/charts/base.tsx:43](https://github.com/databricks/appkit/blob/main/packages/appkit-ui/src/react/charts/base.tsx#L43)

## Properties

### chartType

```ts
chartType: ChartType;
```

Defined in: [packages/appkit-ui/src/react/charts/base.tsx:47](https://github.com/databricks/appkit/blob/main/packages/appkit-ui/src/react/charts/base.tsx#L47)

Chart type

***

### className?

```ts
optional className: string;
```

Defined in: [packages/appkit-ui/src/react/charts/base.tsx:94](https://github.com/databricks/appkit/blob/main/packages/appkit-ui/src/react/charts/base.tsx#L94)

Additional CSS classes

***

### colorPalette?

```ts
optional colorPalette: ChartColorPalette;
```

Defined in: [packages/appkit-ui/src/react/charts/base.tsx:66](https://github.com/databricks/appkit/blob/main/packages/appkit-ui/src/react/charts/base.tsx#L66)

Color palette to use. Auto-selected based on chart type if not specified.
- "categorical": Distinct colors for different categories (bar, pie, line)
- "sequential": Gradient for magnitude (heatmap)
- "diverging": Two-tone for positive/negative (correlation)

***

### colors?

```ts
optional colors: string[];
```

Defined in: [packages/appkit-ui/src/react/charts/base.tsx:68](https://github.com/databricks/appkit/blob/main/packages/appkit-ui/src/react/charts/base.tsx#L68)

Custom colors (overrides colorPalette)

***

### data

```ts
data: ChartData;
```

Defined in: [packages/appkit-ui/src/react/charts/base.tsx:45](https://github.com/databricks/appkit/blob/main/packages/appkit-ui/src/react/charts/base.tsx#L45)

Chart data (Arrow Table or JSON array) - format is auto-detected

***

### height?

```ts
optional height: number;
```

Defined in: [packages/appkit-ui/src/react/charts/base.tsx:55](https://github.com/databricks/appkit/blob/main/packages/appkit-ui/src/react/charts/base.tsx#L55)

Chart height in pixels

#### Default

```ts
300
```

***

### innerRadius?

```ts
optional innerRadius: number;
```

Defined in: [packages/appkit-ui/src/react/charts/base.tsx:80](https://github.com/databricks/appkit/blob/main/packages/appkit-ui/src/react/charts/base.tsx#L80)

Inner radius for pie/donut (0-100)

#### Default

```ts
0
```

***

### labelPosition?

```ts
optional labelPosition: "outside" | "inside" | "center";
```

Defined in: [packages/appkit-ui/src/react/charts/base.tsx:84](https://github.com/databricks/appkit/blob/main/packages/appkit-ui/src/react/charts/base.tsx#L84)

Label position for pie/donut

#### Default

```ts
"outside"
```

***

### max?

```ts
optional max: number;
```

Defined in: [packages/appkit-ui/src/react/charts/base.tsx:90](https://github.com/databricks/appkit/blob/main/packages/appkit-ui/src/react/charts/base.tsx#L90)

Max value for heatmap color scale

***

### min?

```ts
optional min: number;
```

Defined in: [packages/appkit-ui/src/react/charts/base.tsx:88](https://github.com/databricks/appkit/blob/main/packages/appkit-ui/src/react/charts/base.tsx#L88)

Min value for heatmap color scale

***

### options?

```ts
optional options: Record<string, unknown>;
```

Defined in: [packages/appkit-ui/src/react/charts/base.tsx:92](https://github.com/databricks/appkit/blob/main/packages/appkit-ui/src/react/charts/base.tsx#L92)

Additional ECharts options to merge

***

### orientation?

```ts
optional orientation: Orientation;
```

Defined in: [packages/appkit-ui/src/react/charts/base.tsx:53](https://github.com/databricks/appkit/blob/main/packages/appkit-ui/src/react/charts/base.tsx#L53)

Chart orientation

#### Default

```ts
"vertical"
```

***

### showArea?

```ts
optional showArea: boolean;
```

Defined in: [packages/appkit-ui/src/react/charts/base.tsx:78](https://github.com/databricks/appkit/blob/main/packages/appkit-ui/src/react/charts/base.tsx#L78)

Show area fill for radar charts

#### Default

```ts
true
```

***

### showLabels?

```ts
optional showLabels: boolean;
```

Defined in: [packages/appkit-ui/src/react/charts/base.tsx:82](https://github.com/databricks/appkit/blob/main/packages/appkit-ui/src/react/charts/base.tsx#L82)

Show labels on pie/donut slices

#### Default

```ts
true
```

***

### showLegend?

```ts
optional showLegend: boolean;
```

Defined in: [packages/appkit-ui/src/react/charts/base.tsx:59](https://github.com/databricks/appkit/blob/main/packages/appkit-ui/src/react/charts/base.tsx#L59)

Show legend

#### Default

```ts
true
```

***

### showSymbol?

```ts
optional showSymbol: boolean;
```

Defined in: [packages/appkit-ui/src/react/charts/base.tsx:70](https://github.com/databricks/appkit/blob/main/packages/appkit-ui/src/react/charts/base.tsx#L70)

Show data point symbols (line/area charts)

#### Default

```ts
false
```

***

### smooth?

```ts
optional smooth: boolean;
```

Defined in: [packages/appkit-ui/src/react/charts/base.tsx:72](https://github.com/databricks/appkit/blob/main/packages/appkit-ui/src/react/charts/base.tsx#L72)

Smooth line curves (line/area charts)

#### Default

```ts
true
```

***

### stacked?

```ts
optional stacked: boolean;
```

Defined in: [packages/appkit-ui/src/react/charts/base.tsx:74](https://github.com/databricks/appkit/blob/main/packages/appkit-ui/src/react/charts/base.tsx#L74)

Stack series

#### Default

```ts
false
```

***

### symbolSize?

```ts
optional symbolSize: number;
```

Defined in: [packages/appkit-ui/src/react/charts/base.tsx:76](https://github.com/databricks/appkit/blob/main/packages/appkit-ui/src/react/charts/base.tsx#L76)

Symbol size for scatter charts

#### Default

```ts
8
```

***

### title?

```ts
optional title: string;
```

Defined in: [packages/appkit-ui/src/react/charts/base.tsx:57](https://github.com/databricks/appkit/blob/main/packages/appkit-ui/src/react/charts/base.tsx#L57)

Chart title

***

### xKey?

```ts
optional xKey: string;
```

Defined in: [packages/appkit-ui/src/react/charts/base.tsx:49](https://github.com/databricks/appkit/blob/main/packages/appkit-ui/src/react/charts/base.tsx#L49)

X-axis field key (auto-detected from schema if not provided)

***

### yAxisKey?

```ts
optional yAxisKey: string;
```

Defined in: [packages/appkit-ui/src/react/charts/base.tsx:86](https://github.com/databricks/appkit/blob/main/packages/appkit-ui/src/react/charts/base.tsx#L86)

Y-axis field key for heatmap (the row dimension)

***

### yKey?

```ts
optional yKey: string | string[];
```

Defined in: [packages/appkit-ui/src/react/charts/base.tsx:51](https://github.com/databricks/appkit/blob/main/packages/appkit-ui/src/react/charts/base.tsx#L51)

Y-axis field key(s) (auto-detected from schema if not provided)
