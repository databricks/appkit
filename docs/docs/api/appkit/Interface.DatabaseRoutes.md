# Interface: DatabaseRoutes

The generated route entry. `schema` and each module stay lazy, so importing
the registry evaluates neither the schema nor an operation.

## Properties

### modules

```ts
readonly modules: readonly {
  file: string;
  load: () => Promise<Record<string, unknown>>;
}[];
```

***

### schema()

```ts
readonly schema: () => Promise<{
  schema: Schema;
}>;
```

#### Returns

`Promise`\<\{
  `schema`: [`Schema`](Interface.Schema.md);
\}\>
