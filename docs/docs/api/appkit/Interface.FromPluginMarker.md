# Interface: FromPluginMarker

A lazy reference to a plugin's tools, produced by [fromPlugin](Function.fromPlugin.md) and
resolved to concrete `ToolkitEntry`s at `AgentsPlugin.setup()` time.

The marker is spread under a unique symbol key so multiple calls to
`fromPlugin` (even for the same plugin) coexist in an `AgentDefinition.tools`
record without colliding.

## Properties

### \[FROM\_PLUGIN\_MARKER\]

```ts
readonly [FROM_PLUGIN_MARKER]: true;
```

***

### opts

```ts
readonly opts: ToolkitOptions | undefined;
```

***

### pluginName

```ts
readonly pluginName: string;
```
