# Interface: Schema\<TTableName\>

One finalized schema. `TTableName` keeps the declared names in the type, so
configuration that addresses a table by name is checked against the schema
it was written for. Code that accepts any schema uses the default.

## Type Parameters

| Type Parameter | Default type |
| ------ | ------ |
| `TTableName` *extends* `string` | `string` |

## Properties

### $engine

```ts
readonly $engine: Readonly<Record<string, EngineTable>>;
```

***

### $schemaName

```ts
readonly $schemaName: string;
```

***

### $tables

```ts
readonly $tables: Readonly<Record<TTableName, AppKitTable>>;
```
