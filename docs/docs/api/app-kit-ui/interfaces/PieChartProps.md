# Interface: PieChartProps

Defined in: [packages/app-kit-ui/src/react/charts/pie/types.ts:3](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/pie/types.ts#L3)

## Properties

### ariaLabel?

```ts
optional ariaLabel: string;
```

Defined in: [packages/app-kit-ui/src/react/charts/pie/types.ts:15](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/pie/types.ts#L15)

Accessibility label for screen readers

***

### chartConfig?

```ts
optional chartConfig: ChartConfig;
```

Defined in: [packages/app-kit-ui/src/react/charts/pie/types.ts:11](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/pie/types.ts#L11)

Chart configuration overrides

***

### children?

```ts
optional children: ReactNode;
```

Defined in: [packages/app-kit-ui/src/react/charts/pie/types.ts:13](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/pie/types.ts#L13)

Child components for the pie chart

***

### className?

```ts
optional className: string;
```

Defined in: [packages/app-kit-ui/src/react/charts/pie/types.ts:19](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/pie/types.ts#L19)

Additional CSS classes

***

### height?

```ts
optional height: string;
```

Defined in: [packages/app-kit-ui/src/react/charts/pie/types.ts:21](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/pie/types.ts#L21)

Chart height

#### Default

```ts
300px
```

***

### innerRadius?

```ts
optional innerRadius: number;
```

Defined in: [packages/app-kit-ui/src/react/charts/pie/types.ts:23](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/pie/types.ts#L23)

Inner radius of the pie chart

***

### labelField?

```ts
optional labelField: string;
```

Defined in: [packages/app-kit-ui/src/react/charts/pie/types.ts:27](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/pie/types.ts#L27)

Field to use for the label

***

### parameters

```ts
parameters: Record<string, any>;
```

Defined in: [packages/app-kit-ui/src/react/charts/pie/types.ts:7](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/pie/types.ts#L7)

Query Parameters passed to the analytics endpoint

***

### queryKey

```ts
queryKey: string;
```

Defined in: [packages/app-kit-ui/src/react/charts/pie/types.ts:5](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/pie/types.ts#L5)

Analytics query key registered with analytics plugin

***

### showLabel?

```ts
optional showLabel: boolean;
```

Defined in: [packages/app-kit-ui/src/react/charts/pie/types.ts:25](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/pie/types.ts#L25)

Whether to show labels on the pie chart

***

### testId?

```ts
optional testId: string;
```

Defined in: [packages/app-kit-ui/src/react/charts/pie/types.ts:17](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/pie/types.ts#L17)

Test ID for automated testing

***

### transformer()?

```ts
optional transformer: (data) => any[];
```

Defined in: [packages/app-kit-ui/src/react/charts/pie/types.ts:9](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/pie/types.ts#L9)

Transform raw data before rendering

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `data` | `any`[] |

#### Returns

`any`[]

***

### valueField?

```ts
optional valueField: string;
```

Defined in: [packages/app-kit-ui/src/react/charts/pie/types.ts:28](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/charts/pie/types.ts#L28)
