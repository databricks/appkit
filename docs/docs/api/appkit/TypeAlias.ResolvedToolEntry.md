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
  source: "client";
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
  source: "client";
}
```

### def

```ts
def: AgentToolDefinition;
```

### source

```ts
source: "client";
```

UI tool registered by the browser for the duration of a single chat
request. Carried in the per-request tool index, never in the
registered agent's index. Dispatch round-trips to the browser via
the `client_tool_call` SSE event + `POST /chat/client-tool-result`.
