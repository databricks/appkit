# Interface: QueryProps

Defined in: [packages/app-kit-ui/src/react/charts/types.ts:73](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/types.ts#L73)

Props for query-based data fetching

## Extends

- [`ChartBaseProps`](ChartBaseProps.md)

## Properties

### ariaLabel?

```ts
optional ariaLabel: string;
```

Defined in: [packages/app-kit-ui/src/react/charts/types.ts:60](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/types.ts#L60)

Accessibility label for screen readers

#### Inherited from

[`ChartBaseProps`](ChartBaseProps.md).[`ariaLabel`](ChartBaseProps.md#arialabel)

***

### className?

```ts
optional className: string;
```

Defined in: [packages/app-kit-ui/src/react/charts/types.ts:52](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/types.ts#L52)

Additional CSS classes

#### Inherited from

[`ChartBaseProps`](ChartBaseProps.md).[`className`](ChartBaseProps.md#classname)

***

### colorPalette?

```ts
optional colorPalette: ChartColorPalette;
```

Defined in: [packages/app-kit-ui/src/react/charts/types.ts:46](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/types.ts#L46)

Color palette to use. Auto-selected based on chart type if not specified.
- "categorical": Distinct colors for different categories (bar, pie, line)
- "sequential": Gradient for magnitude/intensity (heatmap)
- "diverging": Two-tone for positive/negative values

#### Inherited from

[`ChartBaseProps`](ChartBaseProps.md).[`colorPalette`](ChartBaseProps.md#colorpalette)

***

### colors?

```ts
optional colors: string[];
```

Defined in: [packages/app-kit-ui/src/react/charts/types.ts:48](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/types.ts#L48)

Custom colors for series (overrides colorPalette)

#### Inherited from

[`ChartBaseProps`](ChartBaseProps.md).[`colors`](ChartBaseProps.md#colors)

***

### data?

```ts
optional data: undefined;
```

Defined in: [packages/app-kit-ui/src/react/charts/types.ts:90](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/types.ts#L90)

***

### format?

```ts
optional format: DataFormat;
```

Defined in: [packages/app-kit-ui/src/react/charts/types.ts:85](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/types.ts#L85)

Data format to use
- "json": Use JSON format (smaller payloads, simpler)
- "arrow": Use Arrow format (faster for large datasets)
- "auto": Automatically select based on expected data size

#### Default

```ts
"auto"
```

***

### height?

```ts
optional height: number;
```

Defined in: [packages/app-kit-ui/src/react/charts/types.ts:50](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/types.ts#L50)

Chart height in pixels

#### Default

```ts
300
```

#### Inherited from

[`ChartBaseProps`](ChartBaseProps.md).[`height`](ChartBaseProps.md#height)

***

### options?

```ts
optional options: Record<string, unknown>;
```

Defined in: [packages/app-kit-ui/src/react/charts/types.ts:65](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/types.ts#L65)

Additional ECharts options to merge

#### Inherited from

[`ChartBaseProps`](ChartBaseProps.md).[`options`](ChartBaseProps.md#options)

***

### parameters?

```ts
optional parameters: Record<string, unknown>;
```

Defined in: [packages/app-kit-ui/src/react/charts/types.ts:77](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/types.ts#L77)

Query parameters passed to the analytics endpoint

***

### queryKey

```ts
queryKey: string;
```

Defined in: [packages/app-kit-ui/src/react/charts/types.ts:75](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/types.ts#L75)

Analytics query key registered with analytics plugin

***

### showLegend?

```ts
optional showLegend: boolean;
```

Defined in: [packages/app-kit-ui/src/react/charts/types.ts:39](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/types.ts#L39)

Show legend

#### Inherited from

[`ChartBaseProps`](ChartBaseProps.md).[`showLegend`](ChartBaseProps.md#showlegend)

***

### testId?

```ts
optional testId: string;
```

Defined in: [packages/app-kit-ui/src/react/charts/types.ts:62](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/types.ts#L62)

Test ID for automated testing

#### Inherited from

[`ChartBaseProps`](ChartBaseProps.md).[`testId`](ChartBaseProps.md#testid)

***

### title?

```ts
optional title: string;
```

Defined in: [packages/app-kit-ui/src/react/charts/types.ts:37](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/types.ts#L37)

Chart title

#### Inherited from

[`ChartBaseProps`](ChartBaseProps.md).[`title`](ChartBaseProps.md#title)

***

### transformer()?

```ts
optional transformer: <T>(data) => T;
```

Defined in: [packages/app-kit-ui/src/react/charts/types.ts:87](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/types.ts#L87)

Transform raw data before rendering

#### Type Parameters

| Type Parameter |
| ------ |
| `T` |

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `data` | `T` |

#### Returns

`T`

***

### xKey?

```ts
optional xKey: string;
```

Defined in: [packages/app-kit-ui/src/react/charts/types.ts:55](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/types.ts#L55)

X-axis field key. Auto-detected from schema if not provided.

#### Inherited from

[`ChartBaseProps`](ChartBaseProps.md).[`xKey`](ChartBaseProps.md#xkey)

***

### yKey?

```ts
optional yKey: string | string[];
```

Defined in: [packages/app-kit-ui/src/react/charts/types.ts:57](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/types.ts#L57)

Y-axis field key(s). Auto-detected from schema if not provided.

#### Inherited from

[`ChartBaseProps`](ChartBaseProps.md).[`yKey`](ChartBaseProps.md#ykey)
