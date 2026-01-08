# Function: getRequestContext()

```ts
function getRequestContext(): RequestContext;
```

Defined in: [appkit/src/utils/databricks-client-middleware.ts:100](https://github.com/databricks/appkit/blob/main/packages/appkit/src/utils/databricks-client-middleware.ts#L100)

Retrieve the request-scoped context populated by `databricksClientMiddleware`.
Throws when invoked outside of a request lifecycle.

## Returns

[`RequestContext`](TypeAlias.RequestContext.md)
