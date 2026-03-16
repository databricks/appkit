# Type Alias: ToPlugin()\<T, U, N\>

```ts
type ToPlugin<T, U, N> = (config?: U) => PluginData<T, U, N>;
```

Factory function type returned by `toPlugin()`. Accepts optional config and returns a PluginData tuple.

## Type Parameters

| Type Parameter |
| ------ |
| `T` |
| `U` |
| `N` *extends* `string` |

## Parameters

| Parameter | Type |
| ------ | ------ |
| `config?` | `U` |

## Returns

[`PluginData`](TypeAlias.PluginData.md)\<`T`, `U`, `N`\>
