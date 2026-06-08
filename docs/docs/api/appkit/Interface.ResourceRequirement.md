# Interface: ResourceRequirement

Declares a resource requirement for a plugin.
Can be defined statically in a manifest or dynamically via getResourceRequirements().

Defined as a flat structural shape rather than narrowing the shared
discriminated-union `ResourceRequirement`. The registry needs to construct
and pass these values around at runtime where `type` and `permission` are
looked up dynamically from a string; preserving per-variant tightness here
would force every constructor to thread variant types end-to-end. The
runtime guarantee (permission valid for type) is enforced by the manifest
schema's parse, not by the registry's static types.

## Extended by

- [`ResourceEntry`](Interface.ResourceEntry.md)

## Properties

### alias

```ts
alias: string;
```

Human-readable label for UI/display only.

***

### description

```ts
description: string;
```

Human-readable description of why this resource is needed.

***

### fields

```ts
fields: Record<string, ResourceFieldEntry>;
```

Map of field name to field entry. Required at runtime.

***

### permission

```ts
permission: ResourcePermission;
```

Required permission level for the resource (narrowed to union)

***

### required

```ts
required: boolean;
```

Whether the resource is mandatory at runtime.

***

### resourceKey

```ts
resourceKey: string;
```

Stable key for machine use: deduplication, env naming, composite keys, app.yaml.

***

### type

```ts
type: ResourceType;
```

Type of Databricks resource required (narrowed to enum)
