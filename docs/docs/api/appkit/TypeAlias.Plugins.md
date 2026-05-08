# Type Alias: Plugins

```ts
type Plugins = { readonly [K in keyof RegisteredPlugins]: RegisteredPlugins[K] } & {
[key: string]: PluginToolkitProvider;
};
```

Plugin map passed to the function form of [AgentDefinition.tools](Interface.AgentDefinition.md#tools).
Known names (extended via [RegisteredPlugins](Interface.RegisteredPlugins.md)) keep their concrete
plugin class type; unknown names fall back to [PluginToolkitProvider](Interface.PluginToolkitProvider.md).

## Example

```ts
const support = createAgent({
  instructions: "...",
  tools(plugins) {
    return {
      get_weather: tool({ ... }),
      ...plugins.analytics.toolkit(),
      ...plugins.files.toolkit({ only: ["uploads.read"] }),
    };
  },
});
```
