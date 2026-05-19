# Class: DatabricksAdapter

Adapter that talks directly to Databricks Model Serving `/invocations` endpoint.

No dependency on the Vercel AI SDK or LangChain. Uses raw `fetch()` to POST
OpenAI-compatible payloads and parses the SSE stream itself. Calls
`authenticate()` per-request so tokens are always fresh.

Handles both structured `tool_calls` responses and text-based tool call
fallback parsing for models that output tool calls as text.

## Examples

```ts
import { createApp, createAgent, agents } from "@databricks/appkit";
import { DatabricksAdapter } from "@databricks/appkit/beta";
import { WorkspaceClient } from "@databricks/sdk-experimental";

const adapter = DatabricksAdapter.fromServingEndpoint({
  workspaceClient: new WorkspaceClient({}),
  endpointName: "my-endpoint",
});

await createApp({
  plugins: [
    agents({
      agents: {
        assistant: createAgent({
          instructions: "You are a helpful assistant.",
          model: adapter,
        }),
      },
    }),
  ],
});
```

```ts
const adapter = new DatabricksAdapter({
  endpointUrl: "https://host/serving-endpoints/my-endpoint/invocations",
  authenticate: async () => ({ Authorization: `Bearer ${token}` }),
});
```

## Implements

- [`AgentAdapter`](Interface.AgentAdapter.md)

## Constructors

### Constructor

```ts
new DatabricksAdapter(options: DatabricksAdapterOptions): DatabricksAdapter;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `options` | `DatabricksAdapterOptions` |

#### Returns

`DatabricksAdapter`

## Methods

### run()

```ts
run(input: AgentInput, context: AgentRunContext): AsyncGenerator<AgentEvent, void, unknown>;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `input` | [`AgentInput`](Interface.AgentInput.md) |
| `context` | [`AgentRunContext`](Interface.AgentRunContext.md) |

#### Returns

`AsyncGenerator`\<[`AgentEvent`](TypeAlias.AgentEvent.md), `void`, `unknown`\>

#### Implementation of

[`AgentAdapter`](Interface.AgentAdapter.md).[`run`](Interface.AgentAdapter.md#run)

***

### fromModelServing()

```ts
static fromModelServing(endpointName?: string, options?: ModelServingOptions): Promise<DatabricksAdapter>;
```

Creates a DatabricksAdapter from a Model Serving endpoint name.
Auto-creates a WorkspaceClient internally. Reads the endpoint name
from the argument or the `DATABRICKS_SERVING_ENDPOINT_NAME` env var.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `endpointName?` | `string` |
| `options?` | `ModelServingOptions` |

#### Returns

`Promise`\<`DatabricksAdapter`\>

#### Example

```ts
// Reads endpoint from DATABRICKS_SERVING_ENDPOINT_NAME env var
const adapter = await DatabricksAdapter.fromModelServing();

// Explicit endpoint
const adapter = await DatabricksAdapter.fromModelServing("my-endpoint");

// With options
const adapter = await DatabricksAdapter.fromModelServing("my-endpoint", {
  maxSteps: 5,
  maxTokens: 2048,
});
```

***

### fromServingEndpoint()

```ts
static fromServingEndpoint(options: ServingEndpointOptions): Promise<DatabricksAdapter>;
```

Creates a DatabricksAdapter for a Databricks Model Serving endpoint.

Routes through the shared `connectors/serving/stream` helper, which
delegates to the SDK's `apiClient.request({ raw: true })`. That gives the
adapter centralised URL encoding + authentication with the rest of the
serving surface — no bespoke `fetch()` + `authenticate()` plumbing.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `options` | `ServingEndpointOptions` |

#### Returns

`Promise`\<`DatabricksAdapter`\>
