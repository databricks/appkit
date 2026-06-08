# Type Alias: AgentToolsFn()

```ts
type AgentToolsFn = (plugins: Plugins) => AgentTools;
```

Function form of `AgentDefinition.tools`. Receives the typed
[Plugins](TypeAlias.Plugins.md) map and returns a tool record. Invoked exactly once at
setup (or once per `runAgent` call in standalone mode); the result is
cached as the agent's resolved tool record.

Use the function form when an agent needs tools from registered plugins.
The bare object form is fine when an agent only uses inline tools.

## Parameters

| Parameter | Type |
| ------ | ------ |
| `plugins` | [`Plugins`](TypeAlias.Plugins.md) |

## Returns

[`AgentTools`](TypeAlias.AgentTools.md)
