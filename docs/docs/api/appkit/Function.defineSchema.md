# Function: defineSchema()

```ts
function defineSchema<T>(build: (ctx: SchemaBuilderContext) => T, options: DefineSchemaOptions): Schema<T>;
```

Define a schema. This is used to build the schema for the database.

## Type Parameters

| Type Parameter |
| ------ |
| `T` *extends* `Record`\<`string`, [`AppKitTable`](Interface.AppKitTable.md)\<`string`\>\> |

## Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `build` | (`ctx`: [`SchemaBuilderContext`](Interface.SchemaBuilderContext.md)) => `T` | A function that builds the schema. |
| `options` | [`DefineSchemaOptions`](Interface.DefineSchemaOptions.md) | Options for defining the schema. |

## Returns

[`Schema`](TypeAlias.Schema.md)\<`T`\>

The defined schema.
