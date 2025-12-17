# Interface: UseAnalyticsQueryResult\<T\>

Defined in: [packages/app-kit-ui/src/react/hooks/types.ts:14](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/hooks/types.ts#L14)

Result state returned by useAnalyticsQuery

## Type Parameters

| Type Parameter |
| ------ |
| `T` |

## Properties

### data

```ts
data: T | null;
```

Defined in: [packages/app-kit-ui/src/react/hooks/types.ts:16](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/hooks/types.ts#L16)

Latest query result data

***

### error

```ts
error: string | null;
```

Defined in: [packages/app-kit-ui/src/react/hooks/types.ts:20](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/hooks/types.ts#L20)

Error state of the query

***

### loading

```ts
loading: boolean;
```

Defined in: [packages/app-kit-ui/src/react/hooks/types.ts:18](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/hooks/types.ts#L18)

Loading state of the query
