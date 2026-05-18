# Variable: agents

```ts
const agents: ToPlugin<typeof AgentsPlugin, AgentsPluginConfig, string>;
```

Plugin factory for the agents plugin. Reads `config/agents/*.md` by default,
resolves toolkits/tools from registered plugins, exposes `appkit.agents.*`
runtime API and mounts `/invocations`.

## Example

```ts
import { agents, analytics, createApp, server } from "@databricks/appkit";

await createApp({
  plugins: [server(), analytics(), agents()],
});
```
