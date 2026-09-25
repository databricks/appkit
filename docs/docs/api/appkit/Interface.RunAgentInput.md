# Interface: RunAgentInput

## Properties

### caller?

```ts
optional caller: {
  host: string;
  principal: Principal;
  token: string;
  workspaceId: string;
};
```

Explicit user credentials for standalone execution. Host and workspace ID
are required, so no CLI profile or service-principal identity is selected.
Omit to inherit the ambient scope, or use SP when no caller scope is open.
Obtain the token through a trusted authentication flow, not model input.

#### host

```ts
readonly host: string;
```

#### principal

```ts
readonly principal: Principal;
```

#### token

```ts
readonly token: string;
```

#### workspaceId

```ts
readonly workspaceId: string;
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
dispatches tool calls with the run's ambient principal.

***

### signal?

```ts
optional signal: AbortSignal;
```

Abort signal for cancellation.
