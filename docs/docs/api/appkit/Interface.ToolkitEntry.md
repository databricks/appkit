# Interface: ToolkitEntry

A tool reference produced by a plugin's `.toolkit()` call. The agents plugin
recognizes the `__toolkitRef` brand and dispatches tool invocations through
`PluginContext.executeTool(req, pluginName, localName, ...)`, preserving
OBO (asUser) and telemetry spans.

## Properties

### \_\_toolkitRef

```ts
readonly __toolkitRef: true;
```

***

### annotations?

```ts
optional annotations: ToolAnnotations;
```

***

### autoInheritable?

```ts
optional autoInheritable: boolean;
```

Whether this tool is eligible for `autoInheritTools` spreading. Mirrors
[ToolEntry.autoInheritable](Interface.ToolEntry.md#autoinheritable) from the source registry so the agents
plugin can filter auto-inherited tools without re-walking the provider's
internal registry.

***

### def

```ts
def: AgentToolDefinition;
```

***

### localName

```ts
localName: string;
```

***

### pluginName

```ts
pluginName: string;
```
