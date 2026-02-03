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

Unique alias for this resource within the plugin (e.g., 'warehouse', 'secrets')

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

### env?

```ts
optional env: string;
```

Environment variable name where the resource ID/value should be provided
Example: 'DATABRICKS_WAREHOUSE_ID', 'DATABRICKS_SECRET_SCOPE'

#### Inherited from

[`ResourceRequirement`](Interface.ResourceRequirement.md).[`env`](Interface.ResourceRequirement.md#env)

***

### permission

```ts
permission: ResourcePermission;
```

Required permission level for the resource

#### Inherited from

[`ResourceRequirement`](Interface.ResourceRequirement.md).[`permission`](Interface.ResourceRequirement.md#permission)

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

Whether the resource has been resolved (environment variable found)

***

### type

```ts
type: ResourceType;
```

Type of Databricks resource required

#### Inherited from

[`ResourceRequirement`](Interface.ResourceRequirement.md).[`type`](Interface.ResourceRequirement.md#type)

***

### value?

```ts
optional value: string;
```

The actual value of the resource (if resolved)
