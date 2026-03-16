# Interface: PluginManifest\<TName\>

Plugin manifest that declares metadata and resource requirements.
Attached to plugin classes as a static property.
Extends the shared PluginManifest with strict resource types.

## See

 - `packages/shared/src/schemas/plugin-manifest.generated.ts` `PluginManifest` — generated base
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

Author name or organization

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

Brief description of what the plugin does

#### Inherited from

```ts
Omit.description
```

***

### displayName

```ts
displayName: string;
```

Human-readable display name for UI and CLI

#### Inherited from

```ts
Omit.displayName
```

***

### hidden?

```ts
optional hidden: boolean;
```

When true, this plugin is excluded from the template plugins manifest (appkit.plugins.json) during sync.

#### Inherited from

```ts
Omit.hidden
```

***

### keywords?

```ts
optional keywords: string[];
```

Keywords for plugin discovery

#### Inherited from

```ts
Omit.keywords
```

***

### license?

```ts
optional license: string;
```

SPDX license identifier

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

Message displayed to the user after project initialization. Use this to inform about manual setup steps (e.g. environment variables, resource provisioning).

#### Inherited from

```ts
Omit.onSetupMessage
```

***

### repository?

```ts
optional repository: string;
```

URL to the plugin's source repository

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

### version?

```ts
optional version: string;
```

Plugin version (semver format)

#### Inherited from

```ts
Omit.version
```
