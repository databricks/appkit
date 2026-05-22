# Function: isSupervisorTool()

```ts
function isSupervisorTool(value: unknown): value is HostedSupervisorTool;
```

Type guard for [HostedSupervisorTool](Interface.HostedSupervisorTool.md). Used by the agents plugin
(`buildToolIndex`) and standalone `runAgent` (`classifyTool`) to route
supervisor-hosted tools to the extensions payload rather than the
adapter's `tools` array.

## Parameters

| Parameter | Type |
| ------ | ------ |
| `value` | `unknown` |

## Returns

`value is HostedSupervisorTool`
