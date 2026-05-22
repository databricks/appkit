# Function: fromSupervisorApi()

```ts
function fromSupervisorApi(options: SupervisorApiAdapterOptions): Promise<SupervisorApiAdapter>;
```

Creates an [AgentAdapter](Interface.AgentAdapter.md) backed by the Databricks AI Gateway
Responses API (`/ai-gateway/mlflow/v1/responses`).

Uses the SDK's default credential chain for auth (reads DATABRICKS_HOST,
DATABRICKS_TOKEN, OAuth config, etc.). Tools are declared on the agent
(via `createAgent({ tools })`), not on this factory.

Application code should prefer the
[DatabricksAdapter.fromSupervisorApi](Class.DatabricksAdapter.md#fromsupervisorapi) static — it delegates here
and keeps a single `DatabricksAdapter.from*` autocomplete root for all
Databricks-backed adapters. This free function is the implementation
behind the static and remains exported for callers that want to import
it directly without pulling in [DatabricksAdapter](Class.DatabricksAdapter.md).

## Parameters

| Parameter | Type |
| ------ | ------ |
| `options` | [`SupervisorApiAdapterOptions`](Interface.SupervisorApiAdapterOptions.md) |

## Returns

`Promise`\<[`SupervisorApiAdapter`](Class.SupervisorApiAdapter.md)\>

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

## Remarks

⚠ When passing your own `workspaceClient`, see the warning on
[SupervisorApiAdapterOptions.workspaceClient](Interface.SupervisorApiAdapterOptions.md#workspaceclient) — the client is
captured once and reused, so per-request OBO clients would leak
identity across requests.

## See

[DatabricksAdapter.fromSupervisorApi](Class.DatabricksAdapter.md#fromsupervisorapi) — the recommended
application-facing entry point.
