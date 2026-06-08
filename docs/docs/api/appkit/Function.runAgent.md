# Function: runAgent()

```ts
function runAgent(def: AgentDefinition, input: RunAgentInput): Promise<RunAgentResult>;
```

Standalone agent execution without `createApp`. Resolves the adapter, binds
inline tools, and drives the adapter's `run()` loop to completion.

Limitations vs. running through the agents() plugin:
- **No OBO and no approval gate** — there is no HTTP request, so plugin
  tools run as the service principal. The agents-plugin approval gate
  that prompts for human confirmation on `effect: "write" | "update" |
  "destructive"` tools is also absent. LLM-controlled tool arguments
  flow straight through to the SP. Treat standalone runAgent as a
  trusted-prompt environment (CI, batch eval, internal scripts) — not
  as an exposed user-facing surface.
- **Hosted tools (MCP) are not supported** — they require a live MCP
  client that only exists inside the agents plugin's lifecycle.
  `runAgent` rejects them at index-build time with a clear error.
- **Sub-agents** (`agents: { ... }` on the def) are executed as nested
  `runAgent` calls with no shared thread state. Plugin instances ARE
  shared across the recursion (same cache as the parent).
- **Plugin tools** (used inside the function form via
  `plugins.<name>.toolkit(...)`) require passing `plugins: [...]` via
  `RunAgentInput`. Each plugin in that array is constructed once,
  `attachContext({})` and `await setup()` are called eagerly, and the
  resulting instance is shared across the top-level run and all
  sub-agent recursions. Plugins whose `setup()` requires runtime that
  only `createApp` provides (e.g. `WorkspaceClient`, `ServiceContext`,
  `PluginContext`) throw at standalone-init time with a clear "use
  createApp instead" message — not mid-stream.

## Parameters

| Parameter | Type |
| ------ | ------ |
| `def` | [`AgentDefinition`](Interface.AgentDefinition.md) |
| `input` | [`RunAgentInput`](Interface.RunAgentInput.md) |

## Returns

`Promise`\<[`RunAgentResult`](Interface.RunAgentResult.md)\>
