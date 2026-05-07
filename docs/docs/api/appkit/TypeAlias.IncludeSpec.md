# Type Alias: IncludeSpec

```ts
type IncludeSpec = Record<string, true | IncludeOptions>;
```

Eager-load shape: relation name → either `true` (all default) or an options
bag. The runtime resolves relation names against the parent table's
`$relations` metadata; unknown names throw at query time.
