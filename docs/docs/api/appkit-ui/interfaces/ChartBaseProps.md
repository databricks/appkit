# Interface: ChartBaseProps

Defined in: [packages/appkit-ui/src/react/charts/types.ts:35](https://github.com/databricks/appkit/blob/main/packages/appkit-ui/src/react/charts/types.ts#L35)

Common visual and behavior props for all charts

## Extended by

- [`DataProps`](DataProps.md)
- [`QueryProps`](QueryProps.md)

## Properties

### ariaLabel?

```ts
optional ariaLabel: string;
```

Defined in: [packages/appkit-ui/src/react/charts/types.ts:60](https://github.com/databricks/appkit/blob/main/packages/appkit-ui/src/react/charts/types.ts#L60)

Accessibility label for screen readers

***

### className?

```ts
optional className: string;
```

Defined in: [packages/appkit-ui/src/react/charts/types.ts:52](https://github.com/databricks/appkit/blob/main/packages/appkit-ui/src/react/charts/types.ts#L52)

Additional CSS classes

***

### colorPalette?

```ts
optional colorPalette: ChartColorPalette;
```

Defined in: [packages/appkit-ui/src/react/charts/types.ts:46](https://github.com/databricks/appkit/blob/main/packages/appkit-ui/src/react/charts/types.ts#L46)

Color palette to use. Auto-selected based on chart type if not specified.
- "categorical": Distinct colors for different categories (bar, pie, line)
- "sequential": Gradient for magnitude/intensity (heatmap)
- "diverging": Two-tone for positive/negative values

***

### colors?

```ts
optional colors: string[];
```

Defined in: [packages/appkit-ui/src/react/charts/types.ts:48](https://github.com/databricks/appkit/blob/main/packages/appkit-ui/src/react/charts/types.ts#L48)

Custom colors for series (overrides colorPalette)

***

### height?

```ts
optional height: number;
```

Defined in: [packages/appkit-ui/src/react/charts/types.ts:50](https://github.com/databricks/appkit/blob/main/packages/appkit-ui/src/react/charts/types.ts#L50)

Chart height in pixels

#### Default

```ts
300
```

***

### options?

```ts
optional options: Record<string, unknown>;
```

Defined in: [packages/appkit-ui/src/react/charts/types.ts:65](https://github.com/databricks/appkit/blob/main/packages/appkit-ui/src/react/charts/types.ts#L65)

Additional ECharts options to merge

***

### showLegend?

```ts
optional showLegend: boolean;
```

Defined in: [packages/appkit-ui/src/react/charts/types.ts:39](https://github.com/databricks/appkit/blob/main/packages/appkit-ui/src/react/charts/types.ts#L39)

Show legend

***

### testId?

```ts
optional testId: string;
```

Defined in: [packages/appkit-ui/src/react/charts/types.ts:62](https://github.com/databricks/appkit/blob/main/packages/appkit-ui/src/react/charts/types.ts#L62)

Test ID for automated testing

***

### title?

```ts
optional title: string;
```

Defined in: [packages/appkit-ui/src/react/charts/types.ts:37](https://github.com/databricks/appkit/blob/main/packages/appkit-ui/src/react/charts/types.ts#L37)

Chart title

***

### xKey?

```ts
optional xKey: string;
```

Defined in: [packages/appkit-ui/src/react/charts/types.ts:55](https://github.com/databricks/appkit/blob/main/packages/appkit-ui/src/react/charts/types.ts#L55)

X-axis field key. Auto-detected from schema if not provided.

***

### yKey?

```ts
optional yKey: string | string[];
```

Defined in: [packages/appkit-ui/src/react/charts/types.ts:57](https://github.com/databricks/appkit/blob/main/packages/appkit-ui/src/react/charts/types.ts#L57)

Y-axis field key(s). Auto-detected from schema if not provided.
