# Interface: ResourceFieldEntry

Defines a single field for a resource. Each field has its own environment variable and optional description.
Single-value types use one key (e.g. id); multi-value types (database, secret) use multiple (e.g. instance_name, database_name or scope, key).

## Properties

### description?

```ts
optional description: string;
```

Human-readable description for this field

***

### env

```ts
env: string;
```

Environment variable name for this field
