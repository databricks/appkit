# Interface: AgentDefinition

## Properties

### agents?

```ts
optional agents: Record<string, AgentDefinition>;
```

Sub-agents, exposed as `agent-<key>` tools on this agent.

***

### baseSystemPrompt?

```ts
optional baseSystemPrompt: BaseSystemPromptOption;
```

Override the plugin's baseSystemPrompt for this agent only.

***

### ephemeral?

```ts
optional ephemeral: boolean;
```

When true, the thread used for a chat request against this agent is
deleted from `ThreadStore` after the stream completes (success or
failure). Use for stateless one-shot agents — e.g. autocomplete, where
each request is independent and retaining history would both poison
future calls and accumulate unbounded state in the default
`InMemoryThreadStore`. Defaults to `false`.

***

### instructions

```ts
instructions: string;
```

System prompt body. For markdown-loaded agents this is the file body.

***

### maxSteps?

```ts
optional maxSteps: number;
```

***

### maxTokens?

```ts
optional maxTokens: number;
```

***

### model?

```ts
optional model: 
  | string
  | AgentAdapter
| Promise<AgentAdapter>;
```

Model adapter (or endpoint-name string sugar for
`DatabricksAdapter.fromServingEndpoint({ endpointName })`). Optional —
falls back to the plugin's `defaultModel`.

***

### name?

```ts
optional name: string;
```

Stable identifier for the agent. **Optional and informational** —
when the definition is registered via `agents: { foo: def }` (code) or
lives at `config/agents/<id>/agent.md` (markdown), the **registry key
always wins** and `name` is ignored. The agent will be reachable as
`foo` (or `<id>`) regardless of what this field contains.

Set `name` when:
  - Running standalone via `runAgent({ agent: def })`, where there is
    no enclosing key. The runtime uses it for the agent's slot in
    error messages and OTel spans.
  - Building a definition that may be passed to either form and you
    want a consistent fallback label.

Setting `name` to a value that differs from the registry key is
harmless but confusing — prefer keeping them aligned or omitting `name`
entirely.

***

### tools?

```ts
optional tools: 
  | AgentTools
  | AgentToolsFn;
```

Per-agent tool record. Key is the LLM-visible tool-call name.

Accepts either a plain record (for agents that only use inline tools)
or a function `(plugins) => Record<string, AgentTool>` that receives
the typed [Plugins](TypeAlias.Plugins.md) map and returns a tool record (for agents
that pull tools from registered plugins).

The function is invoked once at agent setup; the result is cached.
Don't put per-request logic in there.
