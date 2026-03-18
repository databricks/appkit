# Interface: IAgentConfig

Base configuration interface for AppKit plugins

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

***

### host?

```ts
optional host: string;
```

#### Inherited from

[`BasePluginConfig`](Interface.BasePluginConfig.md).[`host`](Interface.BasePluginConfig.md#host)

***

### model?

```ts
optional model: string;
```

Databricks model serving endpoint name (e.g. "databricks-claude-sonnet-4-5").
Falls back to DATABRICKS_MODEL env var.
Ignored when `agentInstance` is provided.

***

### name?

```ts
optional name: string;
```

#### Inherited from

[`BasePluginConfig`](Interface.BasePluginConfig.md).[`name`](Interface.BasePluginConfig.md#name)

***

### systemPrompt?

```ts
optional systemPrompt: string;
```

System prompt injected at the start of every conversation

***

### telemetry?

```ts
optional telemetry: TelemetryOptions;
```

#### Inherited from

[`BasePluginConfig`](Interface.BasePluginConfig.md).[`telemetry`](Interface.BasePluginConfig.md#telemetry)

***

### tools?

```ts
optional tools: AgentTool[];
```

Tools to register with the agent. Accepts:
- OpenResponses-aligned `FunctionTool` objects (local tool with execute handler)
- Databricks hosted tools (`genie`, `vector_search_index`, `custom_mcp_server`, `external_mcp_server`)

Ignored when `agentInstance` is provided.
