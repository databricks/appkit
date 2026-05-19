# Interface: McpConnectAllResult

Per-endpoint outcome of [AppKitMcpClient.connectAll](Class.AppKitMcpClient.md#connectall). Callers (the
agents plugin in particular) use the split to warn at startup when some
MCP servers are unreachable without aborting boot for the rest.

## Properties

### connected

```ts
connected: string[];
```

***

### failed

```ts
failed: {
  error: Error;
  name: string;
}[];
```

#### error

```ts
error: Error;
```

#### name

```ts
name: string;
```
