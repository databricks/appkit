# Type Alias: UserScopedApp\<U\>

```ts
type UserScopedApp<U> = ScopedPluginMap<U> & {
  run: Promise<T>;
};
```

## Type Declaration

### run()

```ts
run<T>(fn: (kit: ScopedPluginMap<U>) => T | Promise<T>): Promise<T>;
```

#### Type Parameters

| Type Parameter |
| ------ |
| `T` |

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `fn` | (`kit`: [`ScopedPluginMap`](TypeAlias.ScopedPluginMap.md)\<`U`\>) => `T` \| `Promise`\<`T`\> |

#### Returns

`Promise`\<`T`\>

## Type Parameters

| Type Parameter |
| ------ |
| `U` *extends* readonly [`PluginData`](TypeAlias.PluginData.md)\<`PluginConstructor`, `unknown`, `string`\>[] |
