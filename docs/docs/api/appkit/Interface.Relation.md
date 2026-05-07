# Interface: Relation

A relation between two tables. This is used to define the foreign key relationships between tables.

## Properties

### fromColumn

```ts
fromColumn: string;
```

***

### onDelete?

```ts
optional onDelete: "cascade" | "set null" | "restrict" | "no action";
```

***

### onUpdate?

```ts
optional onUpdate: "cascade" | "set null" | "restrict" | "no action";
```

***

### toColumn

```ts
toColumn: string;
```

***

### toTable

```ts
toTable: string;
```
