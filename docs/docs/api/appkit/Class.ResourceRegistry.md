# Class: ResourceRegistry

Central registry for tracking plugin resource requirements.
Implements singleton pattern to ensure a single source of truth.

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

### get()

```ts
get(type: string, alias: string): ResourceEntry | undefined;
```

Gets a specific resource by type and alias.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `type` | `string` | Resource type |
| `alias` | `string` | Resource alias |

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
If a resource with the same type+alias already exists, merges them:
- Combines plugin names (comma-separated)
- Uses the most permissive permission
- Marks as required if any plugin requires it
- Combines descriptions if they differ
- Keeps the env variable (or merges if they differ)

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

***

### getInstance()

```ts
static getInstance(): ResourceRegistry;
```

Gets the singleton instance of the ResourceRegistry.
Creates a new instance if one doesn't exist.

#### Returns

`ResourceRegistry`

***

### resetInstance()

```ts
static resetInstance(): void;
```

Resets the singleton instance.
Primarily used for testing to ensure clean state between tests.

#### Returns

`void`
