# Interface: UseChartDataResult

Defined in: [packages/app-kit-ui/src/react/hooks/use-chart-data.ts:30](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/hooks/use-chart-data.ts#L30)

## Properties

### data

```ts
data: ChartData | null;
```

Defined in: [packages/app-kit-ui/src/react/hooks/use-chart-data.ts:32](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/hooks/use-chart-data.ts#L32)

The fetched data (Arrow Table or JSON array)

***

### error

```ts
error: string | null;
```

Defined in: [packages/app-kit-ui/src/react/hooks/use-chart-data.ts:38](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/hooks/use-chart-data.ts#L38)

Error message if any

***

### isArrow

```ts
isArrow: boolean;
```

Defined in: [packages/app-kit-ui/src/react/hooks/use-chart-data.ts:34](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/hooks/use-chart-data.ts#L34)

Whether the data is in Arrow format

***

### isEmpty

```ts
isEmpty: boolean;
```

Defined in: [packages/app-kit-ui/src/react/hooks/use-chart-data.ts:40](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/hooks/use-chart-data.ts#L40)

Whether the data is empty

***

### loading

```ts
loading: boolean;
```

Defined in: [packages/app-kit-ui/src/react/hooks/use-chart-data.ts:36](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/hooks/use-chart-data.ts#L36)

Loading state
