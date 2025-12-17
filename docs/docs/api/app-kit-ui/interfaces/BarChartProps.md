# Interface: BarChartProps

Defined in: [packages/app-kit-ui/src/react/charts/bar/types.ts:4](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/bar/types.ts#L4)

Props for the BarChart component

## Properties

### ariaLabel?

```ts
optional ariaLabel: string;
```

Defined in: [packages/app-kit-ui/src/react/charts/bar/types.ts:22](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/bar/types.ts#L22)

Accessibility label for screen readers

***

### chartConfig?

```ts
optional chartConfig: ChartConfig;
```

Defined in: [packages/app-kit-ui/src/react/charts/bar/types.ts:14](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/bar/types.ts#L14)

Char configuration overrides

***

### children?

```ts
optional children: ReactNode;
```

Defined in: [packages/app-kit-ui/src/react/charts/bar/types.ts:19](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/bar/types.ts#L19)

Custom Recharts component for full control mode

***

### className?

```ts
optional className: string;
```

Defined in: [packages/app-kit-ui/src/react/charts/bar/types.ts:27](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/bar/types.ts#L27)

Additional CSS classes

***

### height?

```ts
optional height: string;
```

Defined in: [packages/app-kit-ui/src/react/charts/bar/types.ts:29](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/bar/types.ts#L29)

Chart height

#### Default

```ts
300px
```

***

### orientation?

```ts
optional orientation: "horizontal" | "vertical";
```

Defined in: [packages/app-kit-ui/src/react/charts/bar/types.ts:16](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/bar/types.ts#L16)

Chart orientation

#### Default

```ts
vertical
```

***

### parameters

```ts
parameters: Record<string, any>;
```

Defined in: [packages/app-kit-ui/src/react/charts/bar/types.ts:8](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/bar/types.ts#L8)

Query Parameters passed to the analytics endpoint

***

### queryKey

```ts
queryKey: string;
```

Defined in: [packages/app-kit-ui/src/react/charts/bar/types.ts:6](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/bar/types.ts#L6)

Analytics query key registered with analytics plugin

***

### testId?

```ts
optional testId: string;
```

Defined in: [packages/app-kit-ui/src/react/charts/bar/types.ts:24](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/bar/types.ts#L24)

Test ID for automated testing

***

### transformer()?

```ts
optional transformer: (data) => any[];
```

Defined in: [packages/app-kit-ui/src/react/charts/bar/types.ts:11](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/bar/types.ts#L11)

Transform raw data before rendering

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `data` | `any`[] |

#### Returns

`any`[]
