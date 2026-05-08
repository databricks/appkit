# Interface: RegisteredPlugins

Module-augmentation interface. Core plugins extend this from their
declaration site so the function form of `AgentDefinition.tools`
autocompletes both available plugin keys and the methods on each
plugin (notably `.toolkit()`).

Third-party plugins may extend this interface to participate in the
typed surface:

```ts
declare module "@databricks/appkit" {
  interface RegisteredPlugins {
    myPlugin: MyPlugin;
  }
}
```

Plugins not registered here still work at runtime (they appear under
the index-signature fallback as [PluginToolkitProvider](Interface.PluginToolkitProvider.md)), they
just don't get keyed autocomplete.

## Properties

### analytics

```ts
analytics: AnalyticsPlugin;
```

***

### files

```ts
files: FilesPlugin;
```

***

### genie

```ts
genie: GeniePlugin;
```

***

### lakebase

```ts
lakebase: LakebasePlugin;
```
