# Function: timestamp()

```ts
function timestamp(options: {
  timezone?: boolean;
  withTimezone?: boolean;
}): AppKitColumnChain;
```

Create a timestamp column.

## Parameters

| Parameter | Type |
| ------ | ------ |
| `options` | \{ `timezone?`: `boolean`; `withTimezone?`: `boolean`; \} |
| `options.timezone?` | `boolean` |
| `options.withTimezone?` | `boolean` |

## Returns

[`AppKitColumnChain`](Interface.AppKitColumnChain.md)

The wrapped column chain.
