# Function: database()

```ts
function database<TSchema>(config: IDatabaseConfig<TSchema>): {
  config: IDatabaseConfig<TSchema>;
  name: "database";
  plugin: PluginConstructor<BasePluginConfig, DatabasePlugin<TSchema>>;
};
```

Create a typed database plugin registration for a finalized schema.

## Type Parameters

| Type Parameter |
| ------ |
| `TSchema` *extends* [`Schema`](Interface.Schema.md) |

## Parameters

| Parameter | Type |
| ------ | ------ |
| `config` | [`IDatabaseConfig`](TypeAlias.IDatabaseConfig.md)\<`TSchema`\> |

## Returns

```ts
{
  config: IDatabaseConfig<TSchema>;
  name: "database";
  plugin: PluginConstructor<BasePluginConfig, DatabasePlugin<TSchema>>;
}
```

### config

```ts
config: IDatabaseConfig<TSchema>;
```

### name

```ts
name: "database";
```

### plugin

```ts
plugin: PluginConstructor<BasePluginConfig, DatabasePlugin<TSchema>>;
```
