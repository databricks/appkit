# Function: fromPlugin()

```ts
function fromPlugin<F>(factory: F, opts?: ToolkitOptions): FromPluginSpread;
```

Reference a plugin's tools inside an `AgentDefinition.tools` record without
naming the plugin instance. The returned spread-friendly object carries a
symbol-keyed marker that the agents plugin resolves against registered
`ToolProvider`s at setup time.

The factory argument must come from `toPlugin` (or any function that
carries a `pluginName` field). `fromPlugin` reads `factory.pluginName`
synchronously — it does not construct an instance.

If the referenced plugin is also registered in `createApp({ plugins })`, the
same runtime instance is used for dispatch. If the plugin is missing,
`AgentsPlugin.setup()` throws with a clear `Available: …` listing.

## Type Parameters

| Type Parameter |
| ------ |
| `F` *extends* `NamedPluginFactory` |

## Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `factory` | `F` | A plugin factory produced by `toPlugin`. Must expose a `pluginName` field. |
| `opts?` | [`ToolkitOptions`](Interface.ToolkitOptions.md) | Optional toolkit scoping — `prefix`, `only`, `except`, `rename`. Same shape as the `.toolkit()` method. |

## Returns

`FromPluginSpread`

## Example

```ts
import { analytics, createAgent, files, fromPlugin, tool } from "@databricks/appkit";

const support = createAgent({
  instructions: "You help customers.",
  tools: {
    ...fromPlugin(analytics),
    ...fromPlugin(files, { only: ["uploads.read"] }),
    get_weather: tool({ ... }),
  },
});
```
