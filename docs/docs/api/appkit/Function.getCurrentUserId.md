# ~~Function: getCurrentUserId()~~

```ts
function getCurrentUserId(): string;
```

## Returns

`string`

## Deprecated

Use getCurrentPrincipalKey for new cache keys or getCurrentActorId
for audit. Preserves the bare user or service ID for existing callers.
