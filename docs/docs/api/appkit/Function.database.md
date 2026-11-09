# Function: database()

## Call Signature

```ts
function database<TSchema>(config: IDatabaseConfig<TSchema> & {
  schema: TSchema;
}): DatabaseRegistration<TSchema> & {
  config: IDatabaseConfig<TSchema> & {
     schema: TSchema;
  };
};
```

Create the database plugin. Omit configuration to load
`config/database/schema.ts`, or supply a typed schema override.

### Type Parameters

| Type Parameter |
| ------ |
| `TSchema` *extends* [`Schema`](Interface.Schema.md)\<`string`\> |

### Parameters

| Parameter | Type |
| ------ | ------ |
| `config` | [`IDatabaseConfig`](TypeAlias.IDatabaseConfig.md)\<`TSchema`\> & \{ `schema`: `TSchema`; \} |

### Returns

`DatabaseRegistration`\<`TSchema`\> & \{
  `config`: [`IDatabaseConfig`](TypeAlias.IDatabaseConfig.md)\<`TSchema`\> & \{
     `schema`: `TSchema`;
  \};
\}

## Call Signature

```ts
function database<TSchema>(config?: IDatabaseConfig<TSchema>): DatabaseRegistration<TSchema>;
```

Register the database plugin. By default, setup discovers operations from
`server/database/routes/` through its generated registry. Pass `routes: false`
for server-only access, or a registry to override discovery. Without a schema
override, setup loads the registry's schema or `config/database/schema.ts`.
Registration itself performs no file or database I/O.

### Type Parameters

| Type Parameter | Default type |
| ------ | ------ |
| `TSchema` *extends* [`Schema`](Interface.Schema.md)\<`string`\> | `DefaultDatabaseSchema` |

### Parameters

| Parameter | Type |
| ------ | ------ |
| `config?` | [`IDatabaseConfig`](TypeAlias.IDatabaseConfig.md)\<`TSchema`\> |

### Returns

`DatabaseRegistration`\<`TSchema`\>
