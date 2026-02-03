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

Unique alias for this resource within the plugin (e.g., 'warehouse', 'secrets')

***

### description

```ts
description: string;
```

Human-readable description of why this resource is needed

***

### env?

```ts
optional env: string;
```

Environment variable name where the resource ID/value should be provided
Example: 'DATABRICKS_WAREHOUSE_ID', 'DATABRICKS_SECRET_SCOPE'

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

### type

```ts
type: ResourceType;
```

Type of Databricks resource required
