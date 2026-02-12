# Interface: ResourceEntry

Internal representation of a resource in the registry.
Extends ResourceRequirement with resolution state and plugin ownership.

## Extends

- [`ResourceRequirement`](Interface.ResourceRequirement.md)

## Properties

### alias

```ts
alias: string;
```

Unique alias for this resource within the plugin (e.g., 'warehouse', 'secrets'). Used for UI/display.

#### Inherited from

[`ResourceRequirement`](Interface.ResourceRequirement.md).[`alias`](Interface.ResourceRequirement.md#alias)

***

### description

```ts
description: string;
```

Human-readable description of why this resource is needed

#### Inherited from

[`ResourceRequirement`](Interface.ResourceRequirement.md).[`description`](Interface.ResourceRequirement.md#description)

***

### fields

```ts
fields: Record<string, ResourceFieldEntry>;
```

Map of field name to env and optional description.
Single-value types use one key (e.g. id); multi-value (database, secret) use multiple keys.

#### Inherited from

[`ResourceRequirement`](Interface.ResourceRequirement.md).[`fields`](Interface.ResourceRequirement.md#fields)

***

### permission

```ts
permission: ResourcePermission;
```

Required permission level for the resource

#### Inherited from

[`ResourceRequirement`](Interface.ResourceRequirement.md).[`permission`](Interface.ResourceRequirement.md#permission)

***

### permissionSources?

```ts
optional permissionSources: Record<string, ResourcePermission>;
```

Per-plugin permission tracking.
Maps plugin name to the permission it originally requested.
Populated when multiple plugins share the same resource.

***

### plugin

```ts
plugin: string;
```

Plugin(s) that require this resource (comma-separated if multiple)

***

### required

```ts
required: boolean;
```

Whether this resource is required (true) or optional (false)

#### Inherited from

[`ResourceRequirement`](Interface.ResourceRequirement.md).[`required`](Interface.ResourceRequirement.md#required)

***

### resolved

```ts
resolved: boolean;
```

Whether the resource has been resolved (all field env vars set)

***

### resourceKey

```ts
resourceKey: string;
```

Stable key for machine use (env naming, composite keys, app.yaml). Required.

#### Inherited from

[`ResourceRequirement`](Interface.ResourceRequirement.md).[`resourceKey`](Interface.ResourceRequirement.md#resourcekey)

***

### type

```ts
type: ResourceType;
```

Type of Databricks resource required

#### Inherited from

[`ResourceRequirement`](Interface.ResourceRequirement.md).[`type`](Interface.ResourceRequirement.md#type)

***

### values?

```ts
optional values: Record<string, string>;
```

Resolved value per field name. Populated by validate() when all field env vars are set.
