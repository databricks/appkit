# Interface: ResourceRequirement

Declares a resource requirement for a plugin.
Can be defined statically in a manifest or dynamically via getResourceRequirements().

## Extended by

- [`ResourceEntry`](Interface.ResourceEntry.md)

## Properties

### alias

```ts
alias: string;
```

Unique alias for this resource within the plugin (e.g., 'warehouse', 'secrets'). Used for UI/display.

***

### description

```ts
description: string;
```

Human-readable description of why this resource is needed

***

### fields

```ts
fields: Record<string, ResourceFieldEntry>;
```

Map of field name to env and optional description.
Single-value types use one key (e.g. id); multi-value (database, secret) use multiple keys.

***

### permission

```ts
permission: ResourcePermission;
```

Required permission level for the resource

***

### required

```ts
required: boolean;
```

Whether this resource is required (true) or optional (false)

***

### resourceKey

```ts
resourceKey: string;
```

Stable key for machine use (env naming, composite keys, app.yaml). Required.

***

### type

```ts
type: ResourceType;
```

Type of Databricks resource required
