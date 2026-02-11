# Function: getResourceRequirements()

```ts
function getResourceRequirements(plugin: PluginConstructor): {
  alias: string;
  description: string;
  fields: Record<string, ResourceFieldEntry>;
  permission: ResourcePermission;
  required: boolean;
  resourceKey: string;
  type: ResourceType;
}[];
```

Gets the resource requirements from a plugin's manifest.

Combines required and optional resources into a single array with the
`required` flag set appropriately.

## Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `plugin` | `PluginConstructor` | The plugin constructor class |

## Returns

Combined array of required and optional resources

## Throws

If the plugin manifest is missing or invalid

## Example

```typescript
const resources = getResourceRequirements(AnalyticsPlugin);
for (const resource of resources) {
  console.log(`${resource.type}: ${resource.description} (required: ${resource.required})`);
}
```
