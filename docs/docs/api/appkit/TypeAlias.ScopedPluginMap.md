# Type Alias: ScopedPluginMap\<U\>

```ts
type ScopedPluginMap<U> = { [P in U[number] as P["name"]]: ScopedExports<PluginExports<InstanceType<P["plugin"]>>> };
```

## Type Parameters

| Type Parameter |
| ------ |
| `U` *extends* readonly [`PluginData`](TypeAlias.PluginData.md)\<`PluginConstructor`, `unknown`, `string`\>[] |
