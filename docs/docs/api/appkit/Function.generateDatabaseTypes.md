# Function: generateDatabaseTypes()

```ts
function generateDatabaseTypes(options: GenerateDatabaseTypesOptions): Promise<void>;
```

Read `config/database/schema.ts`, walk it, and emit the registry
augmentation to the configured output file. Silently returns when the
schema file does not exist — apps that don't use the database plugin pay
nothing.

The algorithm:

1. Read the schema source from disk (plain text — we hash it, not the AST).
2. On cache hit, re-emit the cached output and return early.
3. Otherwise call the module loader to get the live `Schema` object.
4. Walk the schema into flat `RegistryEntry`s (row/insert/update/filters/includes).
5. Render the `declare module` block and write it.
6. Update the cache with the new hash+output.

## Parameters

| Parameter | Type |
| ------ | ------ |
| `options` | `GenerateDatabaseTypesOptions` |

## Returns

`Promise`\<`void`\>
