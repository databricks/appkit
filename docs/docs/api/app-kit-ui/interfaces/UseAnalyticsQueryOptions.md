# Interface: UseAnalyticsQueryOptions\<F\>

Defined in: [packages/app-kit-ui/src/react/hooks/types.ts:35](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/hooks/types.ts#L35)

Options for configuring an analytics SSE query

## Type Parameters

| Type Parameter | Default type |
| ------ | ------ |
| `F` *extends* [`AnalyticsFormat`](../type-aliases/AnalyticsFormat.md) | `"JSON"` |

## Properties

### autoStart?

```ts
optional autoStart: boolean;
```

Defined in: [packages/app-kit-ui/src/react/hooks/types.ts:43](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/hooks/types.ts#L43)

Whether to automatically start the query when the hook is mounted. Default is true.

***

### format?

```ts
optional format: F;
```

Defined in: [packages/app-kit-ui/src/react/hooks/types.ts:37](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/hooks/types.ts#L37)

Response format - "JSON" returns typed arrays, "ARROW" returns TypedArrowTable

***

### maxParametersSize?

```ts
optional maxParametersSize: number;
```

Defined in: [packages/app-kit-ui/src/react/hooks/types.ts:40](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/hooks/types.ts#L40)

Maximum size of serialized parameters in bytes
