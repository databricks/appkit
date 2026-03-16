# Interface: ResourceRequirement

Declares a resource requirement for a plugin.
Can be defined statically in a manifest or dynamically via getResourceRequirements().
Narrows the generated base: type → ResourceType enum, permission → ResourcePermission union.

## See

 - `packages/shared/src/schemas/plugin-manifest.generated.ts` `ResourceRequirement` — generated base
 - SharedResourceRequirement — shared re-export with runtime `fields` and `required`

## Extends

- `ResourceRequirement`

## Extended by

- [`ResourceEntry`](Interface.ResourceEntry.md)

## Properties

### alias

```ts
alias: string;
```

Human-readable label for UI/display only. Deduplication uses resourceKey, not alias.

#### Inherited from

```ts
SharedResourceRequirement.alias
```

***

### description

```ts
description: string;
```

Human-readable description of why this resource is needed

#### Inherited from

```ts
SharedResourceRequirement.description
```

***

### fields

```ts
fields: Record<string, ResourceFieldEntry>;
```

Map of field name to env and optional description. Single-value types use one key (e.g. id); multi-value (database, secret) use multiple (e.g. instance_name, database_name or scope, key).

#### Inherited from

```ts
SharedResourceRequirement.fields
```

***

### permission

```ts
permission: ResourcePermission;
```

Required permission level for the resource (narrowed to union)

#### Overrides

```ts
SharedResourceRequirement.permission
```

***

### required

```ts
required: boolean;
```

#### Inherited from

```ts
SharedResourceRequirement.required
```

***

### resourceKey

```ts
resourceKey: string;
```

Stable key for machine use: deduplication, env naming, composite keys, app.yaml. Required for registry lookup.

#### Inherited from

```ts
SharedResourceRequirement.resourceKey
```

***

### type

```ts
type: ResourceType;
```

Type of Databricks resource required (narrowed to enum)

#### Overrides

```ts
SharedResourceRequirement.type
```
