# Function: extractServingEndpoints()

```ts
function extractServingEndpoints(serverFilePath: string): 
  | Record<string, EndpointConfig>
  | null;
```

Extract serving endpoint config from a server file by AST-parsing it.
Looks for `serving({ endpoints: { alias: { env: "..." }, ... } })` calls
and extracts the endpoint alias names and their environment variable mappings.

## Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `serverFilePath` | `string` | Absolute path to the server entry file |

## Returns

  \| `Record`\<`string`, [`EndpointConfig`](Interface.EndpointConfig.md)\>
  \| `null`

Extracted endpoint config, or null if not found or not extractable
