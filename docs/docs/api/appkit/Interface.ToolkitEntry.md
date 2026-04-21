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
