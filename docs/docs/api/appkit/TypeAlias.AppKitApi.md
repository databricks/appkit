# Type Alias: AppKitApi\<U\>

```ts
type AppKitApi<U> = PluginMap<U> & {
  asUser: UserScopedApp<U>;
};
```

App instance with plugin exports and an explicit caller-scoped entry point.

## Type Declaration

### asUser()

```ts
asUser(req: IAppRequest): UserScopedApp<U>;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `req` | `IAppRequest` |

#### Returns

[`UserScopedApp`](TypeAlias.UserScopedApp.md)\<`U`\>

## Type Parameters

| Type Parameter |
| ------ |
| `U` *extends* readonly [`PluginData`](TypeAlias.PluginData.md)\<`PluginConstructor`, `unknown`, `string`\>[] |
