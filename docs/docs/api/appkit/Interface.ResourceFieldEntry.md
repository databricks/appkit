# Interface: ResourceFieldEntry

Defines a single field for a resource. Each field has its own environment variable and optional description.
Single-value types use one key (e.g. id); multi-value types (database, secret) use multiple (e.g. instance_name, database_name or scope, key).

## Properties

### bundleIgnore?

```ts
optional bundleIgnore: boolean;
```

When true, this field is excluded from Databricks bundle configuration (e.g. app.yaml) generation.

***

### description?

```ts
optional description: string;
```

Human-readable description for this field

***

### env?

```ts
optional env: string;
```

Environment variable name for this field

***

### examples?

```ts
optional examples: string[];
```

Example values showing the expected format for this field
