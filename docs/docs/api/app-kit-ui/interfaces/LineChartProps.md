# Interface: LineChartProps

Defined in: [packages/app-kit-ui/src/react/charts/line/types.ts:3](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/line/types.ts#L3)

## Properties

### ariaLabel?

```ts
optional ariaLabel: string;
```

Defined in: [packages/app-kit-ui/src/react/charts/line/types.ts:15](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/line/types.ts#L15)

Accessibility label for screen readers

***

### chartConfig?

```ts
optional chartConfig: ChartConfig;
```

Defined in: [packages/app-kit-ui/src/react/charts/line/types.ts:13](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/line/types.ts#L13)

Chart configuration overrides

***

### children?

```ts
optional children: ReactNode;
```

Defined in: [packages/app-kit-ui/src/react/charts/line/types.ts:11](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/line/types.ts#L11)

Custom Recharts component for full control mode

***

### className?

```ts
optional className: string;
```

Defined in: [packages/app-kit-ui/src/react/charts/line/types.ts:19](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/line/types.ts#L19)

Additional CSS classes

***

### curveType?

```ts
optional curveType: "step" | "linear" | "natural" | "basis" | "monotone";
```

Defined in: [packages/app-kit-ui/src/react/charts/line/types.ts:23](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/line/types.ts#L23)

Curve type for the line

***

### height?

```ts
optional height: string;
```

Defined in: [packages/app-kit-ui/src/react/charts/line/types.ts:21](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/line/types.ts#L21)

Chart height

#### Default

```ts
300px
```

***

### parameters

```ts
parameters: Record<string, any>;
```

Defined in: [packages/app-kit-ui/src/react/charts/line/types.ts:7](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/line/types.ts#L7)

Query Parameters passed to the analytics endpoint

***

### queryKey

```ts
queryKey: string;
```

Defined in: [packages/app-kit-ui/src/react/charts/line/types.ts:5](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/line/types.ts#L5)

Analytics query key registered with analytics plugin

***

### showDots?

```ts
optional showDots: boolean;
```

Defined in: [packages/app-kit-ui/src/react/charts/line/types.ts:25](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/line/types.ts#L25)

Whether to show dots on the line

***

### strokeWidth?

```ts
optional strokeWidth: number;
```

Defined in: [packages/app-kit-ui/src/react/charts/line/types.ts:27](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/line/types.ts#L27)

Stroke width for the line

***

### testId?

```ts
optional testId: string;
```

Defined in: [packages/app-kit-ui/src/react/charts/line/types.ts:17](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/line/types.ts#L17)

Test ID for automated testing

***

### transformer()?

```ts
optional transformer: (data) => any[];
```

Defined in: [packages/app-kit-ui/src/react/charts/line/types.ts:9](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/line/types.ts#L9)

Transform raw data before rendering

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `data` | `any`[] |

#### Returns

`any`[]
