# Type Alias: AgentTool

```ts
type AgentTool = FunctionTool | StructuredToolInterface;
```

A tool that can be registered with the agent plugin.

- `FunctionTool` (preferred): OpenResponses-aligned plain object with JSON Schema parameters.
- `StructuredToolInterface`: LangChain tool for advanced use cases.
