# Interface: AreaChartProps

Defined in: [packages/app-kit-ui/src/react/charts/area/types.ts:4](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/area/types.ts#L4)

Props for the AreaChart component

## Properties

### ariaLabel?

```ts
optional ariaLabel: string;
```

Defined in: [packages/app-kit-ui/src/react/charts/area/types.ts:20](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/area/types.ts#L20)

Accessibility label for screen readers

***

### chartConfig?

```ts
optional chartConfig: ChartConfig;
```

Defined in: [packages/app-kit-ui/src/react/charts/area/types.ts:14](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/area/types.ts#L14)

Chart configuration overrides

***

### children?

```ts
optional children: ReactNode;
```

Defined in: [packages/app-kit-ui/src/react/charts/area/types.ts:17](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/area/types.ts#L17)

Custom Recharts component for full control mode

***

### className?

```ts
optional className: string;
```

Defined in: [packages/app-kit-ui/src/react/charts/area/types.ts:25](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/area/types.ts#L25)

Additional CSS classes

***

### curveType?

```ts
optional curveType: "step" | "linear" | "natural" | "basis" | "monotone";
```

Defined in: [packages/app-kit-ui/src/react/charts/area/types.ts:30](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/area/types.ts#L30)

Curve type for the area

***

### height?

```ts
optional height: string;
```

Defined in: [packages/app-kit-ui/src/react/charts/area/types.ts:27](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/area/types.ts#L27)

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

Defined in: [packages/app-kit-ui/src/react/charts/area/types.ts:8](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/area/types.ts#L8)

Query Parameters passed to the analytics endpoint

***

### queryKey

```ts
queryKey: string;
```

Defined in: [packages/app-kit-ui/src/react/charts/area/types.ts:6](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/area/types.ts#L6)

Analytics query key registered with analytics plugin

***

### testId?

```ts
optional testId: string;
```

Defined in: [packages/app-kit-ui/src/react/charts/area/types.ts:22](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/area/types.ts#L22)

Test ID for automated testing

***

### transformer()?

```ts
optional transformer: (data) => any[];
```

Defined in: [packages/app-kit-ui/src/react/charts/area/types.ts:11](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/area/types.ts#L11)

Transform raw data before rendering

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `data` | `any`[] |

#### Returns

`any`[]
