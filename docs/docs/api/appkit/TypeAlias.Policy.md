# Type Alias: Policy\<In, R\>

```ts
type Policy<In, R> = AllowPolicy<In> | ResourcePolicy<In, R>;
```

A reusable authorization rule, with or without a resource lookup.

## Type Parameters

| Type Parameter | Default type |
| ------ | ------ |
| `In` | `unknown` |
| `R` | `undefined` |
