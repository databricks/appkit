# Function: isApiError()

```ts
function isApiError(err: unknown): err is ApiError | ApiError;
```

True if `err` is a Databricks SDK API error from EITHER the modular
`@databricks/sdk-core/apierror` `ApiError` OR the legacy
`@databricks/sdk-experimental` `ApiError`. Replaces ad-hoc
`error instanceof ApiError` checks at the boundary between AppKit and
the SDK.

## Parameters

| Parameter | Type |
| ------ | ------ |
| `err` | `unknown` |

## Returns

err is ApiError \| ApiError
