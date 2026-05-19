# Function: isToolkitEntry()

```ts
function isToolkitEntry(value: unknown): value is ToolkitEntry;
```

Type guard for `ToolkitEntry` — used by the agents plugin to differentiate
toolkit references from inline tools in a mixed `tools` record.

## Parameters

| Parameter | Type |
| ------ | ------ |
| `value` | `unknown` |

## Returns

`value is ToolkitEntry`
