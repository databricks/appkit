# Class: ResourceRegistry

Central registry for tracking plugin resource requirements.
Deduplication uses type + resourceKey (machine-stable); alias is for display only.

## Constructors

### Constructor

```ts
new ResourceRegistry(): ResourceRegistry;
```

#### Returns

`ResourceRegistry`

## Methods

### clear()

```ts
clear(): void;
```

Clears all registered resources.
Useful for testing or when rebuilding the registry.

#### Returns

`void`

***

### collectResources()

```ts
collectResources(rawPlugins: PluginData<PluginConstructor, unknown, string>[]): void;
```

Collects and registers resource requirements from an array of plugins.
For each plugin, loads its manifest (required) and runtime resource requirements.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `rawPlugins` | [`PluginData`](TypeAlias.PluginData.md)\<`PluginConstructor`, `unknown`, `string`\>[] | Array of plugin data entries from createApp configuration |

#### Returns

`void`

#### Throws

If any plugin is missing a manifest or manifest is invalid

***

### enforceValidation()

```ts
enforceValidation(): ValidationResult;
```

Validates all registered resources and enforces the result.

- In production: throws a [ConfigurationError](Class.ConfigurationError.md) if any required resources are missing.
- In development (`NODE_ENV=development`): logs a warning but continues, unless
  `APPKIT_STRICT_VALIDATION=true` is set, in which case throws like production.
- When all resources are valid: logs a debug message with the count.

#### Returns

[`ValidationResult`](Interface.ValidationResult.md)

ValidationResult with validity status, missing resources, and all resources

#### Throws

In production when required resources are missing, or in dev when APPKIT_STRICT_VALIDATION=true

***

### get()

```ts
get(type: string, resourceKey: string): ResourceEntry | undefined;
```

Gets a specific resource by type and resourceKey (dedup key).

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `type` | `string` | Resource type |
| `resourceKey` | `string` | Stable machine key (not alias; alias is for display only) |

#### Returns

[`ResourceEntry`](Interface.ResourceEntry.md) \| `undefined`

The resource entry if found, undefined otherwise

***

### getAll()

```ts
getAll(): ResourceEntry[];
```

Retrieves all registered resources.
Returns a copy of the array to prevent external mutations.

#### Returns

[`ResourceEntry`](Interface.ResourceEntry.md)[]

Array of all registered resource entries

***

### getByPlugin()

```ts
getByPlugin(pluginName: string): ResourceEntry[];
```

Gets all resources required by a specific plugin.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `pluginName` | `string` | Name of the plugin |

#### Returns

[`ResourceEntry`](Interface.ResourceEntry.md)[]

Array of resources where the plugin is listed as a requester

***

### getOptional()

```ts
getOptional(): ResourceEntry[];
```

Gets all optional resources (where required=false).

#### Returns

[`ResourceEntry`](Interface.ResourceEntry.md)[]

Array of optional resource entries

***

### getRequired()

```ts
getRequired(): ResourceEntry[];
```

Gets all required resources (where required=true).

#### Returns

[`ResourceEntry`](Interface.ResourceEntry.md)[]

Array of required resource entries

***

### register()

```ts
register(plugin: string, resource: ResourceRequirement): void;
```

Registers a resource requirement for a plugin.
If a resource with the same type+resourceKey already exists, merges them:
- Combines plugin names (comma-separated)
- Uses the most permissive permission (per-type hierarchy)
- Marks as required if any plugin requires it
- Combines descriptions if they differ
- Merges fields; warns when same field name uses different env vars

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `plugin` | `string` | Name of the plugin registering the resource |
| `resource` | [`ResourceRequirement`](Interface.ResourceRequirement.md) | Resource requirement specification |

#### Returns

`void`

***

### size()

```ts
size(): number;
```

Returns the number of registered resources.

#### Returns

`number`

***

### validate()

```ts
validate(): ValidationResult;
```

Validates all registered resources against the environment.

Checks each resource's field environment variables to determine if it's resolved.
Updates the `resolved` and `values` fields on each resource entry.

Only required resources affect the `valid` status - optional resources
are checked but don't cause validation failure.

#### Returns

[`ValidationResult`](Interface.ValidationResult.md)

ValidationResult with validity status, missing resources, and all resources

#### Example

```typescript
const registry = ResourceRegistry.getInstance();
const result = registry.validate();

if (!result.valid) {
  console.error("Missing resources:", result.missing.map(r => Object.values(r.fields).map(f => f.env)));
}
```

***

### formatDevWarningBanner()

```ts
static formatDevWarningBanner(missing: ResourceEntry[]): string;
```

Formats a highly visible warning banner for dev-mode missing resources.
Uses box drawing to ensure the message is impossible to miss in scrolling logs.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `missing` | [`ResourceEntry`](Interface.ResourceEntry.md)[] | Array of missing resource entries |

#### Returns

`string`

Formatted banner string

***

### formatMissingResources()

```ts
static formatMissingResources(missing: ResourceEntry[]): string;
```

Formats missing resources into a human-readable error message.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `missing` | [`ResourceEntry`](Interface.ResourceEntry.md)[] | Array of missing resource entries |

#### Returns

`string`

Formatted error message string
