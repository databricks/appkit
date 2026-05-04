# Type Alias: LakebaseTokenResolver()

```ts
type LakebaseTokenResolver = () => Promise<string | null>;
```

A function that resolves a Lakebase token.

The default `database` plugin runtime no longer uses the Data API path,
so this is reserved for callers that opt into the PostgREST client
directly via `createLakebasePostgrestClient`.

## Returns

`Promise`\<`string` \| `null`\>
