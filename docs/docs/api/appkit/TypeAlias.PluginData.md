# Type Alias: PluginData\<T, U, N\>

```ts
type PluginData<T, U, N> = {
  config: U;
  name: N;
  plugin: T;
};
```

Tuple of plugin class, config, and name. Created by `toPlugin()` and passed to `createApp()`.

## Type Parameters

| Type Parameter |
| ------ |
| `T` |
| `U` |
| `N` |

## Properties

### config

```ts
config: U;
```

***

### name

```ts
name: N;
```

***

### plugin

```ts
plugin: T;
```
