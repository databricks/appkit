# Interface: GenieTool

OpenResponses-style hosted tool definitions for Databricks services.

These types follow the OpenResponses convention of discriminating on `type`.
Internally, each hosted tool is resolved to a DatabricksMCPServer instance
so the agent can call managed MCP endpoints on the workspace.

## Properties

### genie\_space

```ts
genie_space: {
  id: string;
};
```

#### id

```ts
id: string;
```

***

### type

```ts
type: "genie";
```
