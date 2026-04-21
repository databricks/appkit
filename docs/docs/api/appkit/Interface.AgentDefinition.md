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

Filled in from the enclosing key when used in `agents: { foo: def }`.

***

### tools?

```ts
optional tools: AgentTools;
```

Per-agent tool record. Key is the LLM-visible tool-call name.
