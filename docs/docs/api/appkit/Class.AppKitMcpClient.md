# Class: AppKitMcpClient

Lightweight MCP client for Databricks-hosted MCP servers.

Uses raw fetch() with JSON-RPC 2.0 over HTTP — no @modelcontextprotocol/sdk
or LangChain dependency. Supports the Streamable HTTP transport only
(POST with JSON-RPC request, single JSON-RPC response). Implements exactly
four methods: `initialize`, `notifications/initialized`, `tools/list`,
`tools/call`. No prompts/resources/completion/sampling.

All outbound URLs are gated by an McpHostPolicy: unallowlisted hosts
are rejected before the first byte is sent, and workspace credentials are
only forwarded to the same-origin workspace. See `mcp-host-policy.ts`.

Rationale for hand-rolling JSON-RPC instead of `@modelcontextprotocol/sdk`:
see the file-level comment at the top of this module.

## Constructors

### Constructor

```ts
new AppKitMcpClient(
   workspaceHost: string, 
   authenticate: () => Promise<Record<string, string>>, 
   policy: McpHostPolicy, 
   options: {
  dnsLookup?: DnsLookup;
  fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}): AppKitMcpClient;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `workspaceHost` | `string` |
| `authenticate` | () => `Promise`\<`Record`\<`string`, `string`\>\> |
| `policy` | `McpHostPolicy` |
| `options` | \{ `dnsLookup?`: `DnsLookup`; `fetchImpl?`: (`input`: `string` \| `URL` \| `Request`, `init?`: `RequestInit`) => `Promise`\<`Response`\>; \} |
| `options.dnsLookup?` | `DnsLookup` |
| `options.fetchImpl?` | (`input`: `string` \| `URL` \| `Request`, `init?`: `RequestInit`) => `Promise`\<`Response`\> |

#### Returns

`AppKitMcpClient`

## Methods

### callTool()

```ts
callTool(
   qualifiedName: string, 
   args: unknown, 
   authHeaders?: Record<string, string>, 
callerSignal?: AbortSignal): Promise<string>;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `qualifiedName` | `string` |
| `args` | `unknown` |
| `authHeaders?` | `Record`\<`string`, `string`\> |
| `callerSignal?` | `AbortSignal` |

#### Returns

`Promise`\<`string`\>

***

### canForwardWorkspaceAuth()

```ts
canForwardWorkspaceAuth(serverName: string): boolean;
```

Whether the named MCP server may receive workspace-scoped auth headers
(e.g., an OBO bearer token from an end-user request). Callers should gate
auth-forwarding decisions on this to prevent credential exfiltration to
non-workspace hosts.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `serverName` | `string` |

#### Returns

`boolean`

***

### close()

```ts
close(): Promise<void>;
```

#### Returns

`Promise`\<`void`\>

***

### connect()

```ts
connect(endpoint: McpEndpointConfig): Promise<void>;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `endpoint` | `McpEndpointConfig` |

#### Returns

`Promise`\<`void`\>

***

### connectAll()

```ts
connectAll(endpoints: McpEndpointConfig[]): Promise<McpConnectAllResult>;
```

Connects every endpoint in parallel and returns a structured summary so
callers can distinguish "all connected" from "some failed".

Returning the result instead of throwing is deliberate: one
misconfigured MCP server should not take down the entire agents plugin
at boot, and the agents plugin uses the summary to warn at startup with
the failed-endpoint names. Errors are also logged here so a caller
that ignores the return still gets per-endpoint diagnostics.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `endpoints` | `McpEndpointConfig`[] |

#### Returns

`Promise`\<[`McpConnectAllResult`](Interface.McpConnectAllResult.md)\>

`connected` lists the endpoint names that initialised
  successfully; `failed` carries `{ name, error }` for the rest.

***

### getAllToolDefinitions()

```ts
getAllToolDefinitions(): AgentToolDefinition[];
```

#### Returns

[`AgentToolDefinition`](Interface.AgentToolDefinition.md)[]
