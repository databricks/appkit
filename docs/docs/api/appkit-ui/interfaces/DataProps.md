# Interface: DataProps

Defined in: [packages/appkit-ui/src/react/charts/types.ts:98](https://github.com/databricks/appkit/blob/main/packages/appkit-ui/src/react/charts/types.ts#L98)

Props for direct data injection

## Extends

- [`ChartBaseProps`](ChartBaseProps.md)

## Properties

### ariaLabel?

```ts
optional ariaLabel: string;
```

Defined in: [packages/appkit-ui/src/react/charts/types.ts:60](https://github.com/databricks/appkit/blob/main/packages/appkit-ui/src/react/charts/types.ts#L60)

Accessibility label for screen readers

#### Inherited from

[`ChartBaseProps`](ChartBaseProps.md).[`ariaLabel`](ChartBaseProps.md#arialabel)

***

### className?

```ts
optional className: string;
```

Defined in: [packages/appkit-ui/src/react/charts/types.ts:52](https://github.com/databricks/appkit/blob/main/packages/appkit-ui/src/react/charts/types.ts#L52)

Additional CSS classes

#### Inherited from

[`ChartBaseProps`](ChartBaseProps.md).[`className`](ChartBaseProps.md#classname)

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

#### Inherited from

[`ChartBaseProps`](ChartBaseProps.md).[`colorPalette`](ChartBaseProps.md#colorpalette)

***

### colors?

```ts
optional colors: string[];
```

Defined in: [packages/appkit-ui/src/react/charts/types.ts:48](https://github.com/databricks/appkit/blob/main/packages/appkit-ui/src/react/charts/types.ts#L48)

Custom colors for series (overrides colorPalette)

#### Inherited from

[`ChartBaseProps`](ChartBaseProps.md).[`colors`](ChartBaseProps.md#colors)

***

### data

```ts
data: ChartData;
```

Defined in: [packages/appkit-ui/src/react/charts/types.ts:100](https://github.com/databricks/appkit/blob/main/packages/appkit-ui/src/react/charts/types.ts#L100)

Arrow Table or JSON array

***

### format?

```ts
optional format: undefined;
```

Defined in: [packages/appkit-ui/src/react/charts/types.ts:105](https://github.com/databricks/appkit/blob/main/packages/appkit-ui/src/react/charts/types.ts#L105)

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

#### Inherited from

[`ChartBaseProps`](ChartBaseProps.md).[`height`](ChartBaseProps.md#height)

***

### options?

```ts
optional options: Record<string, unknown>;
```

Defined in: [packages/appkit-ui/src/react/charts/types.ts:65](https://github.com/databricks/appkit/blob/main/packages/appkit-ui/src/react/charts/types.ts#L65)

Additional ECharts options to merge

#### Inherited from

[`ChartBaseProps`](ChartBaseProps.md).[`options`](ChartBaseProps.md#options)

***

### parameters?

```ts
optional parameters: undefined;
```

Defined in: [packages/appkit-ui/src/react/charts/types.ts:104](https://github.com/databricks/appkit/blob/main/packages/appkit-ui/src/react/charts/types.ts#L104)

***

### queryKey?

```ts
optional queryKey: undefined;
```

Defined in: [packages/appkit-ui/src/react/charts/types.ts:103](https://github.com/databricks/appkit/blob/main/packages/appkit-ui/src/react/charts/types.ts#L103)

***

### showLegend?

```ts
optional showLegend: boolean;
```

Defined in: [packages/appkit-ui/src/react/charts/types.ts:39](https://github.com/databricks/appkit/blob/main/packages/appkit-ui/src/react/charts/types.ts#L39)

Show legend

#### Inherited from

[`ChartBaseProps`](ChartBaseProps.md).[`showLegend`](ChartBaseProps.md#showlegend)

***

### testId?

```ts
optional testId: string;
```

Defined in: [packages/appkit-ui/src/react/charts/types.ts:62](https://github.com/databricks/appkit/blob/main/packages/appkit-ui/src/react/charts/types.ts#L62)

Test ID for automated testing

#### Inherited from

[`ChartBaseProps`](ChartBaseProps.md).[`testId`](ChartBaseProps.md#testid)

***

### title?

```ts
optional title: string;
```

Defined in: [packages/appkit-ui/src/react/charts/types.ts:37](https://github.com/databricks/appkit/blob/main/packages/appkit-ui/src/react/charts/types.ts#L37)

Chart title

#### Inherited from

[`ChartBaseProps`](ChartBaseProps.md).[`title`](ChartBaseProps.md#title)

***

### transformer?

```ts
optional transformer: undefined;
```

Defined in: [packages/appkit-ui/src/react/charts/types.ts:106](https://github.com/databricks/appkit/blob/main/packages/appkit-ui/src/react/charts/types.ts#L106)

***

### xKey?

```ts
optional xKey: string;
```

Defined in: [packages/appkit-ui/src/react/charts/types.ts:55](https://github.com/databricks/appkit/blob/main/packages/appkit-ui/src/react/charts/types.ts#L55)

X-axis field key. Auto-detected from schema if not provided.

#### Inherited from

[`ChartBaseProps`](ChartBaseProps.md).[`xKey`](ChartBaseProps.md#xkey)

***

### yKey?

```ts
optional yKey: string | string[];
```

Defined in: [packages/appkit-ui/src/react/charts/types.ts:57](https://github.com/databricks/appkit/blob/main/packages/appkit-ui/src/react/charts/types.ts#L57)

Y-axis field key(s). Auto-detected from schema if not provided.

#### Inherited from

[`ChartBaseProps`](ChartBaseProps.md).[`yKey`](ChartBaseProps.md#ykey)
