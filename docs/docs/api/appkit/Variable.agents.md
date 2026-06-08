# Variable: agents

```ts
const agents: ToPlugin<typeof AgentsPlugin, AgentsPluginConfig, string>;
```

Plugin factory for the agents plugin. Reads `config/agents/*.md` by default,
resolves toolkits/tools from registered plugins, exposes `appkit.agents.*`
runtime API and mounts `POST /invocations` and `POST /responses` (aliased
non-streaming invoke endpoints) plus `POST /chat` (streaming, HITL-capable).

## Example

```ts
import { agents, analytics, createApp, server } from "@databricks/appkit";

await createApp({
  plugins: [server(), analytics(), agents()],
});
```
