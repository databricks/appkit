# Interface: UseAnalyticsQueryOptions

Defined in: [packages/app-kit-ui/src/react/hooks/types.ts:2](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/hooks/types.ts#L2)

Options for configuring an analytics SSE query

## Properties

### autoStart?

```ts
optional autoStart: boolean;
```

Defined in: [packages/app-kit-ui/src/react/hooks/types.ts:10](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/hooks/types.ts#L10)

Whether to automatically start the query when the hook is mounted. Default is true.

***

### format?

```ts
optional format: "JSON";
```

Defined in: [packages/app-kit-ui/src/react/hooks/types.ts:4](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/hooks/types.ts#L4)

Response format

***

### maxParametersSize?

```ts
optional maxParametersSize: number;
```

Defined in: [packages/app-kit-ui/src/react/hooks/types.ts:7](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/hooks/types.ts#L7)

Maximum size of serialized parameters in bytes
