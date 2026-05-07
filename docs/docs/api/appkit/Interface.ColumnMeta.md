# Interface: ColumnMeta

Metadata for an AppKit column. This is used to store the column metadata in the schema.

## Properties

### primaryKey?

```ts
optional primaryKey: boolean;
```

***

### private?

```ts
optional private: boolean;
```

Marks this column as private.
Excludes the column from the generated `$insertSchema` and `$updateSchema` (i.e. blocks writes through the validators).

***

### serverGenerated?

```ts
optional serverGenerated: boolean;
```
