# Interface: UseAnalyticsQueryResult\<T\>

Defined in: [packages/app-kit-ui/src/react/hooks/types.ts:47](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/hooks/types.ts#L47)

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

Defined in: [packages/app-kit-ui/src/react/hooks/types.ts:49](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/hooks/types.ts#L49)

Latest query result data

***

### error

```ts
error: string | null;
```

Defined in: [packages/app-kit-ui/src/react/hooks/types.ts:53](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/hooks/types.ts#L53)

Error state of the query

***

### loading

```ts
loading: boolean;
```

Defined in: [packages/app-kit-ui/src/react/hooks/types.ts:51](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/hooks/types.ts#L51)

Loading state of the query
