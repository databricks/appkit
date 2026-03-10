# Interface: IAgentConfig

Base configuration interface for AppKit plugins.

When you do **not** set `agentInstance`, the agent is built from `model`, `tools`, and `mcpServers`. You can then add more tools or MCP servers after app creation via `appkit.agent.addCapabilities()` (see [agent](Variable.agent.md) Plugin API).

## Extends

- [`BasePluginConfig`](Interface.BasePluginConfig.md)

## Indexable

```ts
[key: string]: unknown
```

## Properties

### agentInstance?

```ts
optional agentInstance: AgentInterface;
```

Pre-built agent implementing AgentInterface.
When provided the plugin skips internal LangGraph setup and delegates
directly to this instance. Use this to bring your own agent
implementation or a different LangChain variant.

---

### host?

```ts
optional host: string;
```

#### Inherited from

[`BasePluginConfig`](Interface.BasePluginConfig.md).[`host`](Interface.BasePluginConfig.md#host)

---

### maxTokens?

```ts
optional maxTokens: number;
```

Max tokens to generate (default 2000). Ignored when `agentInstance` is provided.

---

### mcpServers?

```ts
optional mcpServers: DatabricksMCPServer[];
```

MCP servers for Databricks tool integration. Ignored when `agentInstance` is provided. You can add more at runtime with `appkit.agent.addCapabilities({ mcpServers: [...] })`.

---

### model?

```ts
optional model: string;
```

Databricks model serving endpoint name (e.g. "databricks-claude-sonnet-4-5").
Falls back to DATABRICKS_MODEL env var.
Ignored when `agentInstance` is provided.

---

### name?

```ts
optional name: string;
```

#### Inherited from

[`BasePluginConfig`](Interface.BasePluginConfig.md).[`name`](Interface.BasePluginConfig.md#name)

---

### systemPrompt?

```ts
optional systemPrompt: string;
```

System prompt injected at the start of every conversation

---

### telemetry?

```ts
optional telemetry: TelemetryOptions;
```

#### Inherited from

[`BasePluginConfig`](Interface.BasePluginConfig.md).[`telemetry`](Interface.BasePluginConfig.md#telemetry)

---

### temperature?

```ts
optional temperature: number;
```

Sampling temperature (0.0-1.0, default 0.1). Ignored when `agentInstance` is provided.

---

### tools?

```ts
optional tools: StructuredTool<ToolInputSchemaBase, any, any, any>[];
```

Additional LangChain tools to register alongside MCP tools. Ignored when `agentInstance` is provided. You can add more at runtime with `appkit.agent.addCapabilities({ tools: [...] })`.

---

### useResponsesApi?

```ts
optional useResponsesApi: boolean;
```

Whether ChatDatabricks calls the upstream model using the Responses API
instead of the Chat Completions API. Default: false.
Ignored when `agentInstance` is provided.
