# Variable: agents

```ts
const agents: ToPlugin<typeof AgentsPlugin, AgentsPluginConfig, "agents">;
```

Plugin factory for the agents plugin. Discovers agents from
`server/agents/<id>/agent.{ts,md}` by default (markdown still in
`config/agents/` is read as a deprecated fallback), resolves toolkits/tools
from registered plugins, exposes the `appkit.agents.*` runtime API and mounts
`POST /invocations` and `POST /responses` (aliased non-streaming invoke
endpoints) plus `POST /chat` (streaming, HITL-capable).

## Example

```ts
import { agents, analytics, createApp, server } from "@databricks/appkit";

await createApp({
  plugins: [server(), analytics(), agents()],
});
```
