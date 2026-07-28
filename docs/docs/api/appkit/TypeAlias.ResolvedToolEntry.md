# Type Alias: ResolvedToolEntry

```ts
type ResolvedToolEntry = 
  | {
  def: AgentToolDefinition;
  localName: string;
  pluginName: string;
  source: "toolkit";
}
  | {
  def: AgentToolDefinition;
  functionTool: FunctionTool;
  source: "function";
}
  | {
  def: AgentToolDefinition;
  mcpToolName: string;
  source: "mcp";
}
  | {
  agentName: string;
  def: AgentToolDefinition;
  source: "subagent";
}
  | {
  def: AgentToolDefinition;
  source: "hosted-supervisor";
  spec: SupervisorTool;
};
```

Internal tool-index entry after a tool record has been resolved to a dispatchable form.

## Type Declaration

```ts
{
  def: AgentToolDefinition;
  localName: string;
  pluginName: string;
  source: "toolkit";
}
```

### def

```ts
def: AgentToolDefinition;
```

### localName

```ts
localName: string;
```

### pluginName

```ts
pluginName: string;
```

### source

```ts
source: "toolkit";
```

```ts
{
  def: AgentToolDefinition;
  functionTool: FunctionTool;
  source: "function";
}
```

### def

```ts
def: AgentToolDefinition;
```

### functionTool

```ts
functionTool: FunctionTool;
```

### source

```ts
source: "function";
```

```ts
{
  def: AgentToolDefinition;
  mcpToolName: string;
  source: "mcp";
}
```

### def

```ts
def: AgentToolDefinition;
```

### mcpToolName

```ts
mcpToolName: string;
```

### source

```ts
source: "mcp";
```

```ts
{
  agentName: string;
  def: AgentToolDefinition;
  source: "subagent";
}
```

### agentName

```ts
agentName: string;
```

### def

```ts
def: AgentToolDefinition;
```

### source

```ts
source: "subagent";
```

```ts
{
  def: AgentToolDefinition;
  source: "hosted-supervisor";
  spec: SupervisorTool;
}
```

### def

```ts
def: AgentToolDefinition;
```

### source

```ts
source: "hosted-supervisor";
```

Adapter-side hosted tool (executed by the model-host, not by the
Node process). Today: Supervisor API hosted tools (Genie spaces,
UC functions, etc.). The `spec` is opaque to the agents plugin —
it routes the entry into `AgentInput.extensions` for the adapter
that declared the matching `acceptsExtensions` key. `def` is a
synthetic placeholder kept so the index has a uniform shape; it
is intentionally NOT included in the `tools` array passed to
`adapter.run()` (those entries are not callable functions).

### spec

```ts
spec: SupervisorTool;
```
