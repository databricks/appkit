# Interface: AppKitTable\<TName\>

An AppKit table. This is returned by the table builder methods.
This is used to define the table schema and relationships.

## Type Parameters

| Type Parameter | Default type |
| ------ | ------ |
| `TName` *extends* `string` | `string` |

## Properties

### \[APPKIT\_TABLE\]

```ts
readonly [APPKIT_TABLE]: true;
```

***

### $columns

```ts
readonly $columns: Record<string, ColumnMeta>;
```

***

### $drizzle

```ts
readonly $drizzle: unknown;
```

***

### $insertSchema

```ts
readonly $insertSchema: ZodType;
```

***

### $relations

```ts
readonly $relations: Relation[];
```

***

### $updateSchema

```ts
readonly $updateSchema: ZodType;
```

***

### name

```ts
readonly name: TName;
```
