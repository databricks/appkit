# Interface: ConfigSchema

Configuration schema definition for plugin config.
Uses JSON Schema format for validation and documentation.

## Indexable

```ts
[key: string]: unknown
```

Allow additional JSON Schema properties

## Properties

### additionalProperties?

```ts
optional additionalProperties: boolean;
```

***

### items?

```ts
optional items: ConfigSchema;
```

***

### properties?

```ts
optional properties: Record<string, ConfigSchemaProperty>;
```

***

### required?

```ts
optional required: string[];
```

***

### type

```ts
type: "string" | "number" | "boolean" | "object" | "array";
```
