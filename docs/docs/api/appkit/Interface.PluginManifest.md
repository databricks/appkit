# Interface: PluginManifest

Plugin manifest that declares metadata and resource requirements.
Attached to plugin classes as a static property.

## Properties

### author?

```ts
optional author: string;
```

Optional metadata for community plugins

***

### config?

```ts
optional config: {
  schema: JSONSchema7;
};
```

Configuration schema for the plugin.
Defines the shape and validation rules for plugin config.

#### schema

```ts
schema: JSONSchema7;
```

***

### description

```ts
description: string;
```

Brief description of what the plugin does

***

### displayName

```ts
displayName: string;
```

Human-readable display name for UI/CLI

***

### hidden?

```ts
optional hidden: boolean;
```

When true, excluded from the template plugins manifest during sync.

***

### keywords?

```ts
optional keywords: string[];
```

***

### license?

```ts
optional license: string;
```

***

### name

```ts
name: string;
```

Plugin identifier (matches plugin.name)

***

### repository?

```ts
optional repository: string;
```

***

### resources

```ts
resources: {
  optional: Omit<ResourceRequirement, "required">[];
  required: Omit<ResourceRequirement, "required">[];
};
```

Resource requirements declaration

#### optional

```ts
optional: Omit<ResourceRequirement, "required">[];
```

Resources that enhance functionality but are not mandatory

#### required

```ts
required: Omit<ResourceRequirement, "required">[];
```

Resources that must be available for the plugin to function

***

### version?

```ts
optional version: string;
```
