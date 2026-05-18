# Interface: PluginToolkitProvider

Minimum shape every entry in the [Plugins](TypeAlias.Plugins.md) map must expose. Core
plugins (analytics, files, genie, lakebase) implement this directly via
their `.toolkit()` method. The agents plugin and standalone `runAgent`
synthesize this shape for any registered plugin that doesn't implement
`.toolkit()` directly (falling back to `getAgentTools()` walking).

## Methods

### toolkit()

```ts
toolkit(opts?: ToolkitOptions): Record<string, ToolkitEntry>;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `opts?` | [`ToolkitOptions`](Interface.ToolkitOptions.md) |

#### Returns

`Record`\<`string`, [`ToolkitEntry`](Interface.ToolkitEntry.md)\>
