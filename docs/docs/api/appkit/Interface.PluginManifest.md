# Interface: PluginManifest\<TName\>

Plugin manifest that declares metadata and resource requirements.
Attached to plugin classes as a static property.
Extends the shared PluginManifest with strict resource types.

## See

 - `packages/shared/src/schemas/manifest.ts` `pluginManifestSchema` — Zod source of truth
 - SharedPluginManifest — shared re-export with JSONSchema7 config

## Extends

- `Omit`\<`SharedPluginManifest`, `"resources"` \| `"config"`\>

## Type Parameters

| Type Parameter | Default type |
| ------ | ------ |
| `TName` *extends* `string` | `string` |

## Properties

### author?

```ts
optional author: string;
```

#### Inherited from

```ts
Omit.author
```

***

### config?

```ts
optional config: {
  schema: JSONSchema7;
};
```

Configuration schema for the plugin.
Uses JSONSchema7 instead of the generated ConfigSchema (which is too restrictive).

#### schema

```ts
schema: JSONSchema7;
```

***

### description

```ts
description: string;
```

#### Inherited from

```ts
Omit.description
```

***

### displayName

```ts
displayName: string;
```

#### Inherited from

```ts
Omit.displayName
```

***

### hidden?

```ts
optional hidden: boolean;
```

#### Inherited from

```ts
Omit.hidden
```

***

### keywords?

```ts
optional keywords: string[];
```

#### Inherited from

```ts
Omit.keywords
```

***

### license?

```ts
optional license: string;
```

#### Inherited from

```ts
Omit.license
```

***

### name

```ts
name: TName;
```

Plugin identifier — the single source of truth for the plugin's name

#### Overrides

```ts
Omit.name
```

***

### onSetupMessage?

```ts
optional onSetupMessage: string;
```

#### Inherited from

```ts
Omit.onSetupMessage
```

***

### repository?

```ts
optional repository: string;
```

#### Inherited from

```ts
Omit.repository
```

***

### resources

```ts
resources: {
  optional: Omit<ResourceRequirement, "required">[];
  required: Omit<ResourceRequirement, "required">[];
};
```

Resource requirements declaration (with strict ResourceRequirement types)

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

### scaffolding?

```ts
optional scaffolding: {
  rules?: {
     must?: string[];
     never?: string[];
     should?: string[];
  };
};
```

#### rules?

```ts
optional rules: {
  must?: string[];
  never?: string[];
  should?: string[];
};
```

##### rules.must?

```ts
optional must: string[];
```

##### rules.never?

```ts
optional never: string[];
```

##### rules.should?

```ts
optional should: string[];
```

#### Inherited from

```ts
Omit.scaffolding
```

***

### stability?

```ts
optional stability: "beta" | "ga";
```

#### Inherited from

```ts
Omit.stability
```

***

### version?

```ts
optional version: string;
```

#### Inherited from

```ts
Omit.version
```
