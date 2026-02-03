# Interface: ConfigSchemaProperty

Individual property definition in a config schema.

## Properties

### default?

```ts
optional default: unknown;
```

***

### description?

```ts
optional description: string;
```

***

### enum?

```ts
optional enum: unknown[];
```

***

### items?

```ts
optional items: ConfigSchemaProperty;
```

***

### maximum?

```ts
optional maximum: number;
```

***

### maxLength?

```ts
optional maxLength: number;
```

***

### minimum?

```ts
optional minimum: number;
```

***

### minLength?

```ts
optional minLength: number;
```

***

### properties?

```ts
optional properties: Record<string, ConfigSchemaProperty>;
```

***

### type

```ts
type: "string" | "number" | "boolean" | "object" | "array";
```
