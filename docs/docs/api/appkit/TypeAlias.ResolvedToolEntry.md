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
};
```

Internal tool-index entry after a tool record has been resolved to a dispatchable form.
