# Interface: ResourceFieldEntry

Defines a single field for a resource. Each field has its own environment variable and optional description. Single-value types use one key (e.g. id); multi-value types (database, secret) use multiple (e.g. instance_name, database_name or scope, key).

This interface was referenced by `PluginManifest`'s JSON-Schema
via the `definition` "resourceFieldEntry".

## Properties

### bundleIgnore?

```ts
optional bundleIgnore: boolean;
```

When true, this field is excluded from Databricks bundle configuration (databricks.yml) generation.

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

***

### localOnly?

```ts
optional localOnly: boolean;
```

When true, this field is only generated for local .env files. The Databricks Apps platform auto-injects it at deploy time.

***

### resolve?

```ts
optional resolve: string;
```

Named resolver prefixed by resource type (e.g., 'postgres:host'). The CLI resolves this value during the init prompt flow.

***

### value?

```ts
optional value: string;
```

Static value for this field. Used when no prompted or resolved value exists.
