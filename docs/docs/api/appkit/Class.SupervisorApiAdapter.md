# Class: SupervisorApiAdapter

Adapter that calls the Databricks AI Gateway Responses API
(`/ai-gateway/mlflow/v1/responses`).

Streams SSE events in the OpenAI Responses API wire format and maps them
to the AppKit `AgentEvent` protocol. Tool execution is handled
server-side, so the adapter ignores the agents-plugin tool index.

Authentication is handled via the Databricks SDK credential chain — the
same mechanism used by `DatabricksAdapter.fromModelServing`. The transport
is injected via SupervisorApiAdapterCtorOptions.streamBody; the
[fromSupervisorApi](Function.fromSupervisorApi.md) factory wires it through the SDK's
`apiClient.request({ raw: true })`, with active W3C context injected by the
shared serving transport immediately before each request.

Set `DEBUG=appkit:agents:supervisor-api` to log the outbound request
shape (model, instructions length, input shape, tool count) and to be
notified when the recovery path engages (no incremental deltas, text
pulled from `response.completed.output[]`). The no-delta warning includes
a per-turn event-type histogram and the SA-reported status/error/
incomplete_details, so it's already actionable without DEBUG.

Tools are not configured on the adapter. Declare them via
`createAgent({ tools: () => ({ key: supervisorTools.genieSpace({...}) }) })`
(or markdown frontmatter referencing an ambient `supervisorTools.*` entry);
the agents plugin / standalone `runAgent` aggregates hosted-supervisor
entries and routes them to the adapter via
`AgentInput.extensions[SUPERVISOR_EXTENSION_KEY]`. Advanced callers
invoking `adapter.run(...)` directly populate that key themselves.

## Example

```ts
import { createApp, createAgent } from "@databricks/appkit";
import {
  agents,
  DatabricksAdapter,
  supervisorTools,
} from "@databricks/appkit/beta";

await createApp({
  plugins: [
    agents({
      agents: {
        assistant: createAgent({
          instructions: "You are a helpful assistant.",
          model: DatabricksAdapter.fromSupervisorApi({
            model: "databricks-claude-sonnet-4",
          }),
          tools: () => ({
            nyc: supervisorTools.genieSpace({
              id: "01ABCDEF12345678",
              description: "NYC taxi trip records and zones",
            }),
          }),
        }),
      },
    }),
  ],
});
```

## Implements

- [`AgentAdapter`](Interface.AgentAdapter.md)

## Constructors

### Constructor

```ts
new SupervisorApiAdapter(options: SupervisorApiAdapterCtorOptions): SupervisorApiAdapter;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `options` | `SupervisorApiAdapterCtorOptions` |

#### Returns

`SupervisorApiAdapter`

## Properties

### acceptsExtensions

```ts
readonly acceptsExtensions: readonly ["databricks.supervisor"];
```

Capability negotiation: the adapter reads its hosted-tool payload
from [AgentInput.extensions](Interface.AgentInput.md#extensions) under [SUPERVISOR\_EXTENSION\_KEY](Variable.SUPERVISOR_EXTENSION_KEY.md).
The agents plugin uses this list to warn at registration when the tool
index produces extensions the adapter wouldn't consume.

#### Implementation of

[`AgentAdapter`](Interface.AgentAdapter.md).[`acceptsExtensions`](Interface.AgentAdapter.md#acceptsextensions)

***

### consumesInputTools

```ts
readonly consumesInputTools: false = false;
```

Capability negotiation: the adapter does not consume `input.tools`.
Tool execution is owned by the Databricks AI Gateway server-side, so
any function tools or local sub-agents declared on this agent would
be silently dropped — the agents plugin warns at registration when
that combination is detected.

#### Implementation of

[`AgentAdapter`](Interface.AgentAdapter.md).[`consumesInputTools`](Interface.AgentAdapter.md#consumesinputtools)

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
