# Type Alias: Plugins

```ts
type Plugins = Record<string, PluginToolkitProvider>;
```

Plugin map passed to the function form of [AgentDefinition.tools](Interface.AgentDefinition.md#tools).
Each entry exposes a `.toolkit(opts?)` method that returns a record of
[ToolkitEntry](Interface.ToolkitEntry.md) markers ready to be spread into a tool record.

AppKit does not statically know which plugins the surrounding
`createApp` will register, so this is a plain string-keyed record.
Refer to plugins by the name used in `createApp({ plugins: [...] })`;
unknown names resolve to `undefined` at runtime.

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
