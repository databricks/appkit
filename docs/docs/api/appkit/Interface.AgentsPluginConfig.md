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

### autoInheritTools?

```ts
optional autoInheritTools: boolean | AutoInheritToolsConfig;
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

Directory to scan for markdown agent files. Default `./config/agents`. Set to `false` to disable.

***

### host?

```ts
optional host: string;
```

#### Inherited from

[`BasePluginConfig`](Interface.BasePluginConfig.md).[`host`](Interface.BasePluginConfig.md#host)

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
