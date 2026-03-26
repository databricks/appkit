# Interface: CreateAgentConfig

## Properties

### adapter?

```ts
optional adapter: 
  | AgentAdapter
| Promise<AgentAdapter>;
```

Single agent adapter (mutually exclusive with `agents`). Registered as "assistant".

***

### agents?

```ts
optional agents: Record<string, 
  | AgentAdapter
| Promise<AgentAdapter>>;
```

Multiple named agents (mutually exclusive with `adapter`).

***

### cache?

```ts
optional cache: CacheConfig;
```

Cache configuration.

***

### client?

```ts
optional client: WorkspaceClient;
```

Pre-configured WorkspaceClient.

***

### defaultAgent?

```ts
optional defaultAgent: string;
```

Which agent to use when the client doesn't specify one.

***

### host?

```ts
optional host: string;
```

Server host. Defaults to FLASK_RUN_HOST or 0.0.0.0.

***

### plugins?

```ts
optional plugins: PluginData<PluginConstructor, unknown, string>[];
```

Tool-providing plugins (analytics, files, genie, lakebase, etc.)

***

### port?

```ts
optional port: number;
```

Server port. Defaults to DATABRICKS_APP_PORT or 8000.

***

### telemetry?

```ts
optional telemetry: TelemetryConfig;
```

Telemetry configuration.
