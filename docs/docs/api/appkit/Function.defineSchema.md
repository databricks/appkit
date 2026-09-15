# Function: defineSchema()

```ts
function defineSchema<TTables>(builder: (context: SchemaBuilderContext) => TTables, options?: DefineSchemaOptions): Schema<Extract<keyof TTables, string>>;
```

Compile one declared schema. The returned type keeps the table names the
builder returned, so `api.tables` and `hooks` can name only real tables.

## Type Parameters

| Type Parameter |
| ------ |
| `TTables` *extends* `Record`\<`string`, `AppKitTable`\> |

## Parameters

| Parameter | Type |
| ------ | ------ |
| `builder` | (`context`: `SchemaBuilderContext`) => `TTables` |
| `options?` | `DefineSchemaOptions` |

## Returns

[`Schema`](Interface.Schema.md)\<`Extract`\<keyof `TTables`, `string`\>\>
