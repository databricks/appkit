# Interface: RunAgentInput

## Properties

### appName?

```ts
optional appName: string;
```

***

### messages

```ts
messages: string | Message[];
```

Seed messages for the run. Either a single user string or a full message list.

***

### plugins?

```ts
optional plugins: PluginData<PluginConstructor, unknown, string>[];
```

Optional plugin list. Required when `def.tools` is the function form
`(plugins) => Record<string, AgentTool>` and the function dereferences
any plugins. `runAgent` constructs a fresh instance per plugin and
dispatches tool calls against it as the service principal (no OBO —
there is no HTTP request in standalone mode).

***

### requestId?

```ts
optional requestId: string;
```

***

### sessionId?

```ts
optional sessionId: string;
```

***

### signal?

```ts
optional signal: AbortSignal;
```

Abort signal for cancellation.

***

### threadId?

```ts
optional threadId: string;
```

***

### userId?

```ts
optional userId: string;
```
