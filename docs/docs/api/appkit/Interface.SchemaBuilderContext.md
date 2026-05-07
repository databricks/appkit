# Interface: SchemaBuilderContext

A context for the schema builder. This is used to build the schema.

## Properties

### enum()

```ts
enum: (name: string, values: readonly string[]) => AppKitColumnChain;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `name` | `string` |
| `values` | readonly `string`[] |

#### Returns

[`AppKitColumnChain`](Interface.AppKitColumnChain.md)

***

### table()

```ts
table: <TName, TCols>(name: TName, columns: TCols) => AppKitTable<TName>;
```

#### Type Parameters

| Type Parameter |
| ------ |
| `TName` *extends* `string` |
| `TCols` *extends* `Record`\<`string`, [`AppKitColumn`](Interface.AppKitColumn.md)\> |

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `name` | `TName` |
| `columns` | `TCols` |

#### Returns

[`AppKitTable`](Interface.AppKitTable.md)\<`TName`\>
