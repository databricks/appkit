# Interface: AgentsPluginConfig

Base configuration interface for AppKit plugins

## Extends

- [`BasePluginConfig`](Interface.BasePluginConfig.md)

## Indexable

```ts
[key: string]: unknown
```

## Properties

### agents?

```ts
optional agents: Record<string, AgentDefinition>;
```

Code-defined agents, merged with file-loaded ones (code wins on key collision).

***

### approval?

```ts
optional approval: {
  requireForDestructive?: boolean;
  timeoutMs?: number;
};
```

Human-in-the-loop approval gate for mutating tool calls. When enabled
(the default), the agents plugin emits an `appkit.approval_pending` SSE
event before executing any tool whose annotation flags it as mutating —
`effect: "write" | "update" | "destructive"` (preferred) or the legacy
`destructive: true` boolean — and waits for a `POST /chat/approve`
decision from the same user who initiated the stream. A missing decision
after `timeoutMs` auto-denies the call.

#### requireForDestructive?

```ts
optional requireForDestructive: boolean;
```

Require human approval for tools that mutate state. Triggered by
`effect: "write" | "update" | "destructive"` (preferred) or the legacy
`destructive: true` boolean. Default: `true`.

#### timeoutMs?

```ts
optional timeoutMs: number;
```

Milliseconds to wait before auto-denying. Default: 60_000.

***

### autoInheritTools?

```ts
optional autoInheritTools: 
  | boolean
  | AutoInheritToolsConfig;
```

Whether to auto-inherit every ToolProvider plugin's toolkit. Accepts a boolean shorthand.

***

### baseSystemPrompt?

```ts
optional baseSystemPrompt: BaseSystemPromptOption;
```

Customize or disable the AppKit base system prompt.

***

### defaultAgent?

```ts
optional defaultAgent: string;
```

Agent used when clients don't specify one. Defaults to the first-registered agent or the file with `default: true` frontmatter.

***

### defaultModel?

```ts
optional defaultModel: 
  | string
  | AgentAdapter
| Promise<AgentAdapter>;
```

Default model for agents that don't specify their own (in code or frontmatter).

***

### dir?

```ts
optional dir: string | false;
```

Directory of agent packages (`<id>/agent.md` each). Default `./config/agents`. Set to `false` to disable.

***

### host?

```ts
optional host: string;
```

#### Inherited from

[`BasePluginConfig`](Interface.BasePluginConfig.md).[`host`](Interface.BasePluginConfig.md#host)

***

### limits?

```ts
optional limits: {
  maxConcurrentStreamsPerUser?: number;
  maxSubAgentDepth?: number;
  maxToolCalls?: number;
  toolCallTimeoutMs?: number;
};
```

Runtime resource limits applied during agent execution. Defaults are
tuned to protect a single-instance deployment from a misbehaving user or
a runaway prompt injection; tighten or relax as appropriate for the
deployment's scale and trust model. Request-body caps (chat message
size, invocations input size / length) are enforced statically by the
Zod schemas and are not configurable here.

#### maxConcurrentStreamsPerUser?

```ts
optional maxConcurrentStreamsPerUser: number;
```

Max concurrent chat streams a single user may have open. Subsequent
`POST /chat` requests from that user while at-limit are rejected with
HTTP 429. Default: `5`.

#### maxSubAgentDepth?

```ts
optional maxSubAgentDepth: number;
```

Max sub-agent recursion depth. Protects against a prompt-injected
agent that delegates to a sub-agent which in turn delegates back to
itself (directly or transitively). Default: `3`.

#### maxToolCalls?

```ts
optional maxToolCalls: number;
```

Max tool invocations per agent run (across the full tool-call graph,
including sub-agent invocations). A run that exceeds the budget is
aborted with a terminal error event. Default: `50`.

#### toolCallTimeoutMs?

```ts
optional toolCallTimeoutMs: number;
```

Per-call timeout for tools dispatched through `PluginContext`
(toolkit-routed tools — analytics SQL warehouse queries, Genie
messages, Lakebase queries). Independent of `maxToolCalls`: the
budget caps how many tools fire per run, this caps how long any
single tool call may run. The signal handed to plugin tool
implementations combines this timeout with the parent stream's
abort signal via `AbortSignal.any`. Function and MCP tools have
their own timeouts in their respective adapters and ignore this
setting. Default: `300_000` (5 minutes) — generous enough for cold
SQL Warehouse round-trips and long Genie conversations.

***

### mcp?

```ts
optional mcp: McpHostPolicyConfig;
```

MCP server host policy. By default only same-origin Databricks workspace
URLs may be used as MCP endpoints; custom hosts must be explicitly
allowlisted here. Workspace credentials (SP / OBO) are never forwarded
to non-workspace hosts.

***

### name?

```ts
optional name: string;
```

#### Inherited from

[`BasePluginConfig`](Interface.BasePluginConfig.md).[`name`](Interface.BasePluginConfig.md#name)

***

### telemetry?

```ts
optional telemetry: TelemetryOptions;
```

#### Inherited from

[`BasePluginConfig`](Interface.BasePluginConfig.md).[`telemetry`](Interface.BasePluginConfig.md#telemetry)

***

### threadStore?

```ts
optional threadStore: ThreadStore;
```

Persistent thread store. Default: in-memory.

***

### tools?

```ts
optional tools: Record<string, AgentTool>;
```

Ambient tool library. Keys may be referenced by markdown frontmatter via `tools: [key1, key2]`.
