# Interface: UseChartDataOptions

Defined in: [packages/appkit-ui/src/react/hooks/use-chart-data.ts:13](https://github.com/databricks/appkit/blob/main/packages/appkit-ui/src/react/hooks/use-chart-data.ts#L13)

## Properties

### format?

```ts
optional format: DataFormat;
```

Defined in: [packages/appkit-ui/src/react/hooks/use-chart-data.ts:25](https://github.com/databricks/appkit/blob/main/packages/appkit-ui/src/react/hooks/use-chart-data.ts#L25)

Data format preference
- "json": Force JSON format
- "arrow": Force Arrow format
- "auto": Auto-select based on heuristics

#### Default

```ts
"auto"
```

***

### parameters?

```ts
optional parameters: Record<string, unknown>;
```

Defined in: [packages/appkit-ui/src/react/hooks/use-chart-data.ts:17](https://github.com/databricks/appkit/blob/main/packages/appkit-ui/src/react/hooks/use-chart-data.ts#L17)

Query parameters

***

### queryKey

```ts
queryKey: string;
```

Defined in: [packages/appkit-ui/src/react/hooks/use-chart-data.ts:15](https://github.com/databricks/appkit/blob/main/packages/appkit-ui/src/react/hooks/use-chart-data.ts#L15)

Analytics query key

***

### transformer()?

```ts
optional transformer: <T>(data) => T;
```

Defined in: [packages/appkit-ui/src/react/hooks/use-chart-data.ts:27](https://github.com/databricks/appkit/blob/main/packages/appkit-ui/src/react/hooks/use-chart-data.ts#L27)

Transform data after fetching

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
