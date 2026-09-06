# Agents

<!-- AUTO-GENERATED: stability-banner-start -->
:::warning Beta plugin
This plugin is currently **beta**. APIs may change between minor releases. Import from `@databricks/appkit/beta`. See [Plugin Stability Tiers](./stability.md).
:::
<!-- AUTO-GENERATED: stability-banner-end -->

The `agents` plugin turns a Databricks AppKit app into an AI-agent host. It discovers agent definitions from disk — one folder per agent under `server/agents/`, holding either `agent.md` (markdown) or `agent.ts` (code) — and exposes them at `POST /invocations` and `POST /responses` (non-streaming, aliases) alongside `POST /chat` (streaming) and routes for thread management, cancellation, and HITL approval. In every case the agent's id is its folder name; there's no map to maintain and no id to restate.

This page covers the full lifecycle. For the hand-written primitives (`tool()`, `mcpServer()`), see [tools](./server.md).

## Requirements

:::info Streaming-capable serving endpoints only
The agents plugin drives the LLM over Server-Sent Events. Foundation Model APIs (Claude, Llama, GPT, etc.) and other chat-style endpoints support streaming and work out of the box. Custom model endpoints that return a single JSON response (e.g. typical `sklearn` or MLflow `pyfunc` deployments) do **not** stream — pointing an agent at one will fail with "Response body is null — streaming not supported" on the first turn. If you list a serving endpoint in `apps init`, pick one whose model implements the chat-completions streaming protocol; the agents plugin reads its name from `DATABRICKS_SERVING_ENDPOINT_NAME` whenever an agent doesn't pin `model:` itself.

For the non-streaming path against a custom endpoint, use the `serving` plugin's `/invoke` route with `useServingInvoke` instead.

Or skip serving-endpoint setup entirely with the managed [Supervisor API adapter](#managed-agents-the-supervisor-api-adapter) (beta).
:::

## Install

`agents` is a regular plugin. Add it to `plugins[]` alongside `server()` and any ToolProvider plugins whose tools you want agents to reach.

```ts
import { analytics, createApp, files, server } from "@databricks/appkit";
import { agents } from "@databricks/appkit/beta";

await createApp({
  plugins: [server(), analytics(), files(), agents()],
});
```

That alone gives you a live HTTP server with `POST /invocations` (and its alias `POST /responses`) wired to a markdown-driven agent. Use `POST /chat` instead when you want the streaming, HITL-capable surface.

## Level 1: drop a markdown agent package

Each agent lives in its own folder under `server/agents/` with entry file `agent.md`. A folder is an agent only if it holds an entry file (`agent.md` or `agent.ts`); a folder without one is skipped, so per-agent asset folders sit beside the entry — notably a `skills/` folder holding [Skills](#skills) (on-demand instruction packs the agent loads by name). A shared `server/agents/skills/` folder holds skills available to any agent.

```
my-app/
  server/
    server.ts
    agents/
      assistant/
        agent.md
```

```md
---
endpoint: databricks-claude-sonnet-4-5
default: true
---

You are a helpful data assistant running on Databricks.

Use the available tools to query data, browse files, and help users.
```

On startup the plugin:

1. Discovers `server/agents/assistant/agent.md` and registers agent id `assistant`.
2. Parses the YAML frontmatter and markdown body as the agent's `instructions`.
3. Resolves the adapter from `endpoint` (or falls back to `DATABRICKS_SERVING_ENDPOINT_NAME`).
4. Mounts the agent at the default name (`assistant`).

The agent starts with **no tools**. Tools are opt-in — declare them in frontmatter (Level 2 below) or opt into auto-inherit explicitly with `agents({ autoInheritTools: { file: true } })`. See "Auto-inherit posture" further down for what that costs and why it's off by default.

:::note Migrating from `config/agents/`
Earlier versions kept markdown agents under `config/agents/<id>/agent.md`. That location is still read as a deprecated fallback (one-time warning on boot); move each folder to `server/agents/<id>/agent.md` so every agent — markdown and code — lives in one place.
:::

Requests land at `POST /invocations` (or its alias `POST /responses`) with an OpenAI Responses-compatible body. These endpoints run the agent to completion and return a single JSON response — no SSE. Streaming clients should use `POST /chat`. Every tool call runs through `asUser(req)` so SQL executes as the requesting user, file access respects Unity Catalog ACLs, and telemetry spans are created automatically.

:::warning No HITL on `/invocations` and `/responses`
The non-streaming invoke surface has no way to surface a mid-call approval prompt back to the caller. When `approval.requireForDestructive` is enabled (default) and the resolved agent has any tool annotated with a mutating effect (`effect: "write" | "update" | "destructive"`, or the legacy `destructive: true`), `POST /invocations` and `POST /responses` reject the request with HTTP 400 before the adapter runs. Move HITL-capable agents to `POST /chat`, or disable approval via `agents({ approval: { requireForDestructive: false } })` for autonomous back-office agents.
:::

## Level 2: scope tools in frontmatter

```md
---
endpoint: databricks-claude-sonnet-4-5
tools:
  - plugin:analytics                              # all analytics.* tools
  - plugin:files: [uploads.read, uploads.list]    # only these files tools
  - plugin:genie: { except: [getConversation] }   # everything but getConversation
  - get_weather                                   # ambient tool declared in code
default: true
---

You are a read-only data analyst.
```

The unified `tools:` list mixes plugin references and ambient tools, mirroring the TS function form `tools(plugins) => ({ ...plugins.analytics.toolkit(), ...plugins.files.toolkit({ only: [...] }), get_weather: tool({...}) })`. Each entry is one of:

- **`plugin:<name>`** — pull every tool from the named plugin.
- **`plugin:<name>: [tool1, tool2]`** — only the listed tools (sugar for `{ only: [...] }`).
- **`plugin:<name>: { ...ToolkitOptions }`** — full `prefix` / `only` / `except` / `rename` options.
- **`<key>`** (no prefix) — ambient tool name resolved against the `agents({ tools: { ... } })` config.

When any `tools:` is declared the auto-inherit default is turned off — the agent sees exactly the listed tools.

## Level 3: code-defined agents

Code agents live one-per-folder under `server/agents/`, with entry file `agent.ts` (mirroring markdown's `agent.md`). The entry exports a created agent and its **id is the folder name** (`server/agents/support/agent.ts` → `support`). Nothing restates the id.

```ts
// server/agents/support/agent.ts
import { createAgent, tool } from "@databricks/appkit/beta";
import { z } from "zod";

export default createAgent({           // id derived from folder name: "support"
  instructions: "You help customers with data and files.",
  model: "databricks-claude-sonnet-4-5",                      // string sugar
  tools(plugins) {
    return {
      ...plugins.analytics.toolkit(),                          // all analytics tools
      ...plugins.files.toolkit({ only: ["uploads.read"] }),    // filtered subset
      get_weather: tool({
        description: "Weather",
        schema: z.object({ city: z.string() }),
        execute: async ({ city }) => `Sunny in ${city}`,
      }),
    };
  },
});
```

The `agents` plugin discovers these files at startup — no registration, no map:

```ts
// server/server.ts
import { analytics, createApp, files, server } from "@databricks/appkit";
import { agents } from "@databricks/appkit/beta";

await createApp({
  plugins: [server(), analytics(), files(), agents()],   // no agent map, no import
});
```

Discovery imports each `server/agents/<id>/agent.ts` — the source `.ts` under `tsx` in dev, and the compiled `dist/agents/<id>/agent.js` in a production build (built output wins over source, independent of `NODE_ENV`). Because the production server is bundled and only imports things reachable from `server/server.ts`, the template's `tsdown` config lists `server/agents/*/agent.ts` as build entries so `dist/agents/*/agent.js` are emitted for the scan — that wiring is what lets a dropped-in folder survive the prod bundle. (Markdown `agent.md` is read from source in both dev and prod — it's data, not compiled.) The root is always `server/agents` — there is no config option to relocate it; markdown still under `config/agents/` is read as a deprecated fallback (one-time warning).

:::note Built output shadows source in dev
Because compiled output wins over source, a stale `dist/agents` / `build/agents` left over from a previous `npm run build` will be picked up by `npm run dev` instead of your live `server/agents/*.ts`, so edits appear ignored. **Delete the build dir** if a code agent seems frozen — a rebuild only swaps in a newer snapshot, so only deleting it restores live-from-source dev reload. Markdown is always read from source, so `agent.md` edits are never shadowed.
:::

The entry may `export default createAgent({...})` or export a single named created agent; either way the id is the folder name. A folder whose entry exports no created agent (or has no `agent.ts`/`agent.md` at all) is skipped. Mark one agent as the default with `createAgent({ default: true })` (mirrors markdown frontmatter `default: true`); an explicit `agents({ defaultAgent })` still wins.

Code-defined agents start with no tools by default. The function form `tools(plugins) => Record<string, AgentTool>` is the primary way to pull in plugin tools: each plugin registered in `createApp({ plugins: [...] })` shows up on the `plugins` parameter, and you call `.toolkit(opts?)` on it to get a spread-friendly record. The runtime invokes the function once at agent setup and caches the result — every plugin is mentioned exactly once (in `createApp`), with no held variables or marker imports.

Inline `tool({...})` calls live in the same record. Their `name` is optional — the agents plugin overrides it with the record key (`get_weather` above).

Auto-inherit is **off for both origins by default** — a markdown or code agent with no declared `tools:` gets an empty tool index. Opt an origin in explicitly with `agents({ autoInheritTools: { file: true } })` (or `{ code: true }`, or `true` for both).

:::warning Deprecated: the `agents({ agents: { ... } })` map
Passing a hand-built agent map still works and is honored for backward compatibility, but it emits a one-time deprecation warning and will be removed in a future minor. It restates each agent's id (once in `createAgent`, once as the map key); discovery from `server/agents/` removes both the map and the restatement. Migrate by moving each `createAgent(...)` into its own `server/agents/<id>/agent.ts` (default or single named export) and dropping the map. If a discovered agent and a map entry share an id, discovery wins and the map entry is ignored (with a one-time warning). (Inline sub-agents — `createAgent({ agents: { ... } })` on a definition — are unaffected; only the plugin-level map is deprecated.)

Some examples further down still pass agents inline via this map for snippet brevity — in a real app each of those `createAgent(...)` definitions lives in its own `server/agents/<id>/agent.ts` and needs no map.
:::

### Scoping tools in code

`plugins.<name>.toolkit(opts?)` accepts the same `ToolkitOptions` as markdown frontmatter:

| Option | Example | Meaning |
|---|---|---|
| `only` | `{ only: ["query"] }` | Allowlist of local tool names |
| `except` | `{ except: ["legacy"] }` | Denylist of local tool names |
| `prefix` | `{ prefix: "" }` | Drop the `${pluginName}.` prefix |
| `rename` | `{ rename: { query: "q" } }` | Remap specific local names |

For plugins that don't expose a `.toolkit()` method (e.g., third-party `ToolProvider` plugins authored with plain `toPlugin`), the runtime falls back to walking `getAgentTools()` and synthesizing namespaced keys (`${pluginName}.${localName}`). The fallback respects `only` / `except` / `rename` / `prefix` the same way.

If a referenced plugin is not registered in `createApp({ plugins })`, the agents plugin throws at setup with an `Available: …` listing so you can fix the wiring before the first request.

## Level 4: sub-agents

```ts
const researcher = createAgent({
  instructions: "Research the question. Return concise bullets.",
  model: "databricks-claude-sonnet-4-5",
  tools: { search: tool({ /* ... */ }) },
});

const writer = createAgent({
  instructions: "Draft prose from notes.",
  model: "databricks-claude-sonnet-4-5",
});

const supervisor = createAgent({
  instructions: "Coordinate researcher and writer.",
  model: "databricks-claude-sonnet-4-5",
  agents: { researcher, writer },  // exposed as agent-researcher, agent-writer
});

// server/agents/{supervisor,researcher,writer}/agent.ts — one folder each
export default supervisor;

await createApp({
  plugins: [server(), agents()],  // discovered from server/agents/
});
```

Put `supervisor`, `researcher`, and `writer` in their own `server/agents/<id>/agent.ts` folders (default export each) — a markdown parent can also delegate to a code child in a sibling folder via `agents: [helper]` frontmatter. Each key in `agents: {...}` on an `AgentDefinition` becomes an `agent-<key>` tool on the parent. When invoked, the agents plugin runs the child's adapter with a fresh message list (no shared thread state) and returns the aggregated text. Cycles in a code agent's inline `agents: {}` graph are rejected at load (`createAgent`); markdown `agents:` delegation rejects self-references at load and bounds deeper cycles at runtime via `limits.maxSubAgentDepth`.

## Skills

Skills are on-demand instruction packs — the same `SKILL.md` format Claude Code and Cursor use. Only each skill's `name` + `description` sit in the system prompt (always-on, cheap); the full body loads on demand when the agent (or the user) invokes it. This works on any Databricks-served model — AppKit implements the disclosure itself, so it doesn't depend on a provider-native skills feature.

A skill is a directory with a `SKILL.md` plus any bundled reference files:

```
config/agents/
  skills/                    # shared pool — any agent can opt in
    pdf-forms/
      SKILL.md
      reference.md
  planner/
    agent.md
    skills/                  # private to the `planner` agent
      house-style/
        SKILL.md
```

```md
---
name: pdf-forms
description: Fill and validate PDF form fields from a data record.
---

To fill a PDF form:

1. Read `reference.md` for the field-name conventions.
2. ...
```

`name` and `description` are required; `license`, `allowed-tools`, and `metadata` are accepted for compatibility with skills authored elsewhere. Unknown keys warn and are ignored.

### Visibility

- **Per-agent skills** (`config/agents/<id>/skills/`) are always visible to that agent.
- **Global skills** (`config/agents/skills/`, and catalog-volume skills) are **opt-in**: list them in the agent's frontmatter, `skills: [pdf-forms]`. Set `autoInheritSkills: true` (or `{ file, code }`) on the plugin to make every global skill visible without listing — off by default so each agent's always-on catalog stays lean.

### How the agent uses a skill

Two read-only built-in tools are injected into any agent that has a visible catalog:

- `load_skill(skill)` — returns the skill's full instructions plus a manifest of its bundled files.
- `read_skill_file(skill, path)` — returns the contents of one of those bundled files.

The model calls `load_skill` on its own when a task matches a skill's description. A **user** can force a specific skill for a turn with the `/skill-name` prefix in chat (or the `send(message, { skill })` option on `useAgentChat`); the skill's instructions are injected into that turn deterministically, and `load_skill` remains available for auto-selection. The client reads the per-agent catalog from the plugin's `clientConfig()` payload to power a picker.

### Catalog skills (Unity Catalog Volume)

Point `skillsVolume` (or the `DATABRICKS_VOLUME_AGENT_SKILLS` env var) at a UC Volume laid out the same way — `<volume>/<name>/SKILL.md`. Catalog skills are discovered at boot and on `reload()`, merged into the shared global pool, and read as the **service principal** (`skillCredentialMode` defaults to `"sp"`). They're intended as a shared, curated pool; per-user (OBO) skill volumes are not wired yet. Declaring the optional `volume` resource in the manifest lets the scaffolder grant the SP read access.

### Name collisions

Skill names are addressed bare. If two sources provide the same name, each becomes a qualified `<scope>:name` (`agent:`, `bundle:`, `volume:`) and the bare name is rejected as ambiguous with the alternatives listed. Two skills with the same name from the *same* source is a boot-time error.

### v1 caveats

- **Scripts are not executed.** A skill may reference `scripts/foo.py`; v1 loads prose and reference docs only.
- **`allowed-tools` is advisory.** It's surfaced as a hint in the loaded skill, not enforced — loading a skill does not restrict the agent's callable tools. It is not a sandbox.
- **Skill bodies are not per-user access-controlled** (they read as the SP). Keep user-sensitive content out of skill bodies.

## Level 5: standalone (no `createApp`)

```ts
import { createAgent, runAgent, tool } from "@databricks/appkit/beta";
import { z } from "zod";

const classifier = createAgent({
  instructions: "Classify tickets: billing | bug | feature.",
  model: "databricks-claude-sonnet-4-5",
  tools: {
    lookup_account: tool({ /* ... */ }),
  },
});

for (const ticket of tickets) {
  const result = await runAgent(classifier, {
    messages: [{ role: "user", content: ticket.body }],
  });
  await persistClassification(ticket.id, result.text);
}
```

`runAgent` drives the adapter without `createApp` or HTTP. Inline `tool()` calls work standalone as shown above. To use plugin tools in standalone mode, pass the plugin factories through `RunAgentInput.plugins` and reach into them via the `tools(plugins)` function form:

```ts
import { analytics } from "@databricks/appkit";
import { createAgent, runAgent } from "@databricks/appkit/beta";

const classifier = createAgent({
  instructions: "Classify tickets. Use analytics.query for historical data.",
  model: "databricks-claude-sonnet-4-5",
  tools(plugins) {
    return { ...plugins.analytics.toolkit() };
  },
});

const result = await runAgent(classifier, {
  messages: "is ticket 42 a duplicate?",
  plugins: [analytics()],
});
```

`runAgent` eagerly constructs each plugin in `RunAgentInput.plugins`, runs the standard `attachContext({})` + `await setup()` lifecycle, and shares the instances across the top-level run and every sub-agent dispatch. Plugins whose `setup()` requires `createApp`-only runtime (e.g. `WorkspaceClient`, `ServiceContext`) throw at standalone-init with a clear "use createApp instead" message rather than mid-stream.

MCP hosted tools (`mcpServer(...)`) still require `agents()` (they need a live MCP client). Supervisor-API hosted tools (`supervisorTools.*`), by contrast, **work in standalone `runAgent`** — the adapter has everything it needs to execute them server-side. This makes batch-eval / CI use of supervisor agents possible without `createApp`. Plugin tool dispatch in standalone mode runs as the service principal (no OBO) and **bypasses the agents-plugin approval gate** — treat standalone runAgent as a trusted-prompt environment (CI, batch eval, internal scripts), not as an exposed user-facing surface.

## Structured output

Give a code agent an `output` Zod schema and its final answer is validated against that schema instead of returned as freeform text:

```ts
import { createAgent } from "@databricks/appkit/beta";
import { z } from "zod";

export default createAgent({
  instructions: "Classify the support ticket.",
  output: z.object({
    category: z.enum(["billing", "bug", "feature_request", "how_to", "other"]),
    urgent: z.boolean(),
    summary: z.string(),
  }),
});
```

The parsed, schema-valid object shows up on every non-streaming surface and on the stream:

| Surface | Where the object appears |
| --- | --- |
| `POST /invocations`, `POST /responses` | top-level `output_parsed` field on the JSON envelope (next to `output`) |
| `POST /chat` (SSE) | one final `appkit.structured_output` event (`{ data }`) **after** the streamed text |
| in-process `runAgent` | `RunAgentResult.output`, statically typed as `z.infer` of the schema |

```ts
import { runAgent } from "@databricks/appkit/beta";

const { output } = await runAgent(classifier, { messages: ticket });
output?.category; // "billing" | "bug" | … | undefined  — fully typed
```

A per-call override is also available for one-off shapes: `runAgent(agent, input, { output: SomeSchema })` (it takes precedence over the agent's own schema and retypes the result).

**How it works.** The agent answers normally first (streaming its visible text on `/chat`). Structured output is then produced by a dedicated **non-streaming** completion constrained by the schema via `response_format` — Databricks rejects `response_format` under streaming, so the structured call can't be the streamed one. The answer is validated as-is first (a cheap pre-check for a model that already emitted JSON); otherwise the non-streaming pass reformats it. Either way the JSON is validated with Zod; on a mismatch AppKit re-prompts with the validation errors (up to two retries, invisible to the `/chat` text stream) and then throws a `StructuredOutputError` carrying the last raw output — it never returns partial or unvalidated data. If an endpoint rejects `response_format` outright, AppKit strips it and retries, relying on the prompt plus Zod validation.

:::note Scope
Structured output is for **code-config agents** (`createAgent`). Markdown `agent.md` agents can't carry a schema, and sub-agents return text into their parent's context (typing buys nothing there). See the live API reference (`npx @databricks/appkit docs "appkit API reference"`) for the exact `createAgent` / `runAgent` / `StructuredOutputError` signatures.
:::

## Adding agents to an existing app

Already have an app and want to add agents? What you touch depends on the kind:

**Markdown agents** — just the plugin. Drop `server/agents/<id>/agent.md`, add `agents()` to your `plugins`, done. Markdown is read from source at runtime in both dev and prod, so there is no build change.

**Code agents** (`server/agents/<id>/agent.ts`) — also update your server build so a production bundle emits them. Code agents aren't imported anywhere, so a build that only compiles `server/server.ts` never produces `dist/agents/*/agent.js`, and a bundled `npm run build` + start would discover **zero** code agents.

:::warning Dev hides this
`npm run dev` (tsx) imports the `.ts` source directly, so code agents work there with no build change — the gap only appears in a bundled build. If you add code agents but forget the build change, the plugin warns at startup (and names the fix) rather than failing silently.
:::

The one-line fix is to adopt the build preset:

```ts
// tsdown.server.config.ts
import { appkitServerConfig } from '@databricks/appkit/tsdown';

export default appkitServerConfig();
```

`appkitServerConfig()` auto-detects `server/agents/` and adds the entry glob + `clean` only when code agents exist; pass overrides as `appkitServerConfig({ external, define, ... })`, or a function `appkitServerConfig((base) => ({ ...base }))` for full control. It's also the last time you touch this file — future build-wiring changes ship with the package. If you'd rather keep a hand-written config, add the entries yourself:

```ts
entry: ['server/server.ts', 'server/agents/*/agent.ts'],
clean: true,
```

## Managed agents: the Supervisor API adapter

`DatabricksAdapter.fromSupervisorApi` (beta) is the zero-config way to run an agent: instead of provisioning and pointing at a model-serving endpoint, you run the agentic loop in the Databricks workspace by targeting the AI Gateway Responses API (`/ai-gateway/mlflow/v1/responses`), which runs the LLM — and any hosted tools — as a managed service on Databricks. No `DATABRICKS_SERVING_ENDPOINT_NAME`, no stream-capability check, no JS tool plumbing for the common cases.

The minimal agent is one extra line versus a markdown agent:

```ts
import { createApp } from "@databricks/appkit";
import { agents, createAgent, DatabricksAdapter } from "@databricks/appkit/beta";

await createApp({
  plugins: [
    agents({
      agents: {
        assistant: createAgent({
          instructions: "You are a helpful assistant.",
          model: DatabricksAdapter.fromSupervisorApi({
            model: "databricks-claude-sonnet-4-5",
          }),
        }),
      },
    }),
  ],
});
```

`createAgent({ model })` already accepts adapters and adapter promises in addition to the model-name string used in earlier examples, so you can drop the factory result straight in. The factory resolves credentials through the SDK chain (`DATABRICKS_HOST`, OAuth, PAT, …); pass `workspaceClient` to reuse an existing client.

### Hosted tools

Expose Genie spaces, Unity Catalog functions/connections, Knowledge Assistants, or other AppKit apps to the model by declaring them as agent tools — same place every other tool is declared. Execution stays server-side; you write no tool code:

```ts
import {
  createAgent,
  DatabricksAdapter,
  supervisorTools,
} from "@databricks/appkit/beta";

const assistant = createAgent({
  instructions: "You are a helpful data assistant.",
  model: DatabricksAdapter.fromSupervisorApi({
    model: "databricks-claude-sonnet-4-5",
  }),
  tools: () => ({
    nyc: supervisorTools.genieSpace({
      id: "01ABCDEF12345678",
      description: "NYC taxi trip records and zones",
    }),
    add: supervisorTools.ucFunction({
      name: "main.default.add",
      description: "Adds two integers and returns the sum.",
    }),
  }),
});
```

Each `supervisorTools.*` factory takes a single named-options object — routing-critical strings get labels at the call site, so positional-argument swap bugs are impossible.

`description` is **required and non-empty** — the LLM uses it to route between tools, so two Genie spaces both labelled "Genie space" will be indistinguishable.

:::warning Hosted-tool descriptions are trusted application configuration (CWE-1427)
A hosted tool's `description` is read by the LLM to decide when to route to that tool. **Do not derive it from untrusted input** — user messages, request bodies, freeform fields from external systems, or any value an attacker could influence. Treat `description` (and `id`/`name`) as application-controlled, alongside the agent's `instructions`. Allowing a user-controlled string here is a prompt-injection sink: a hostile description can convince the model to route to (or away from) a tool for any future request handled by the agent.

The same caution applies to MCP `description`s and to any other field the model reads at routing time.
:::

| Factory | Tool kind | Identifier |
|---|---|---|
| `supervisorTools.genieSpace({ id, description })` | Genie space | space id |
| `supervisorTools.ucFunction({ name, description })` | Unity Catalog function | three-part name |
| `supervisorTools.knowledgeAssistant({ knowledgeAssistantId, description })` | Knowledge Assistant | assistant id |
| `supervisorTools.app({ name, description })` | Databricks App | app name |
| `supervisorTools.ucConnection({ name, description })` | UC connection | connection name |

### Declaring hosted tools in markdown agents

Hosted-supervisor tools also work in markdown-driven agents: declare the tool in code (under `agents({ tools: { ... } })`) and reference its key in frontmatter:

```ts
// server.ts
agents({
  agents: { /* ... */ },
  tools: {
    nyc_taxi: supervisorTools.genieSpace({
      id: "01ABCDEF12345678",
      description: "NYC taxi trip records and zones",
    }),
  },
});
```

```md
---
endpoint: databricks-claude-sonnet-4-5
tools:
  - nyc_taxi
---

You answer questions about NYC taxi data using the Genie space.
```

No new frontmatter syntax — the ambient-tool lookup in `tools:` already resolves bare keys against `agents({ tools })`, and the tagged-record shape of `supervisorTools.*` lets the plugin classify them automatically.

### What does *not* apply to Supervisor-API agents

The managed runtime owns its own tool execution, so the adapter intentionally **ignores function tools and sub-agents from the agents-plugin tool index**. For any agent whose `model:` is a Supervisor adapter:

- Only `supervisorTools.*` entries reach the model. Function tools (`tool({...})`), MCP hosted tools (`mcpServer(...)`), and local sub-agents (`agents: { ... }`) declared alongside a supervisor adapter will trigger a registration-time warning and **will not be exposed to the model**. The capability check fires from `consumesInputTools: false` on the adapter.
- The **human-in-the-loop approval gate** does not fire (tool calls never enter the Node process; `effect: "destructive"` annotations are irrelevant for hosted tools).
- `limits.maxToolCalls` is not enforced (the managed runtime accounts for its own calls).
- Per-call **OBO** does not apply to hosted tools; they run with the credentials the managed runtime uses for the target resource.

### Cross-adapter sub-agent composition

Supervisor and chat-completions adapters can both appear in the same `agents({ agents: { ... } })` map, but composition only goes one direction:

- **Chat-completions parent → supervisor sub-agent** works natively. The parent dispatches via `agent-{key}` as a regular function tool; the child's adapter runs entirely on the AI Gateway.
- **Supervisor parent → function-tool / local sub-agent children** is not yet wired. The capability check warns at registration; those tools will not reach the supervisor model. Future work will lift this restriction by routing SA's `response.function_call` events through `context.executeTool`.

:::note Recovery path for non-streaming tool turns
Some hosted tool kinds return their final assistant text without incremental `output_text.delta` events. The adapter has a recovery path that pulls the text out of `response.completed.output[]` so the turn is not silently empty. Set `DEBUG=appkit:agents:supervisor-api` to log the per-turn event-type histogram if you want to verify which path a turn took.
:::

## Configuration reference

```ts
agents({
  // Agents live under server/agents/<id>/ (fixed root). config/agents is read as a deprecated fallback.
  agents?: Record<string, AgentDefinition>,  // DEPRECATED — use server/agents/<id>/ discovery
  defaultAgent?: string,
  defaultModel?: AgentAdapter | Promise<AgentAdapter> | string,
  tools?: Record<string, AgentTool>,
  autoInheritTools?: boolean | { file?: boolean, code?: boolean },
  autoInheritSkills?: boolean | { file?: boolean, code?: boolean }, // default off
  skillsVolume?: string,        // UC Volume for catalog skills; falls back to DATABRICKS_VOLUME_AGENT_SKILLS
  skillCredentialMode?: "sp" | "obo", // default "sp" (see Skills)
  threadStore?: ThreadStore,    // default in-memory
  baseSystemPrompt?: false | string | (ctx: PromptContext) => string,
  mcp?: {
    trustedHosts?: string[],    // extra hostnames allowed for custom MCP URLs
    allowLocalhost?: boolean,   // default: NODE_ENV !== "production"
  },
  approval?: {
    requireForDestructive?: boolean,  // default: true
    timeoutMs?: number,               // default: 60_000
  },
  limits?: {
    maxConcurrentStreamsPerUser?: number, // default: 5
    maxToolCalls?: number,                // default: 50
    maxSubAgentDepth?: number,            // default: 3
    toolCallTimeoutMs?: number,           // default: 300_000 (5 min)
  },
})
```

`autoInheritTools` defaults to `{ file: false, code: false }` — no tools spread into any agent unless the developer explicitly opts in. When opted in, only tools whose plugin author marked `autoInheritable: true` are spread; destructive or state-mutating tools are always skipped from the auto-inherit path even when opt-in is enabled. Boolean shorthand (`autoInheritTools: true`) applies to both origins. See "Auto-inherit posture" below.

### MCP host policy

AppKit applies a zero-trust policy to every MCP URL used as a hosted tool. By default only **same-origin Databricks workspace URLs** (matching the resolved `DATABRICKS_HOST`) may be reached. Every other host must be explicitly allowlisted via `mcp.trustedHosts`, and workspace credentials (service-principal and on-behalf-of user tokens) are **never** forwarded to those hosts.

```ts
agents({
  agents: {
    support: createAgent({
      instructions: "…",
      tools: {
        "mcp.internal": mcpServer("internal", "https://mcp.corp.internal/mcp"),
      },
    }),
  },
  mcp: {
    trustedHosts: ["mcp.corp.internal"],
  },
});
```

The policy enforces four rules at MCP `connect()` time, before any byte is sent:

1. Only `http` and `https` URLs are accepted.
2. Plaintext `http://` is rejected for everything except `localhost` when `allowLocalhost` is true (default in development, off in production).
3. The destination hostname must match the workspace host, equal `localhost` (if permitted), or appear in `trustedHosts`.
4. The resolved DNS address must not fall in loopback, RFC1918, CGNAT (100.64.0.0/10), link-local (169.254.0.0/16 — covers cloud metadata services), ULA, or multicast ranges.

`Authorization` headers carrying workspace credentials are scoped to same-origin workspace URLs. A `mcpServer(name, url)` pointing at a trusted external host must authenticate itself (for example, a custom token baked into `url`).

### Auto-inherit posture

AppKit treats auto-inherit as a two-key operation: the developer must opt into `autoInheritTools`, AND the plugin author must mark each tool `autoInheritable: true`. Both are required for a tool to spread into an agent's index without explicit wiring.

```ts
// Opt-in at the agents plugin level (pick one):
agents({ autoInheritTools: true });                   // both origins
agents({ autoInheritTools: { file: true } });         // markdown agents only
agents({ autoInheritTools: { file: true, code: true } });

// Per-tool, inside a plugin:
defineTool({
  description: "safe read",
  schema: z.object({ ... }),
  annotations: { effect: "read", requiresUserContext: true },
  autoInheritable: true, // explicit consent that this tool may auto-spread
  execute: (args, signal) => ...,
});
```

The AppKit core plugins ship with the following `autoInheritable` markings:

| Tool | `autoInheritable` | Rationale |
|---|---|---|
| `analytics.query` | yes | OBO-scoped, read-only SQL enforced at runtime via the classifier |
| `files.list` / `files.read` / `files.exists` / `files.metadata` | yes | OBO-scoped read operations |
| `files.upload` / `files.delete` | no | Mutating — wire explicitly |
| `genie.getConversation` | yes | Read-only history |
| `genie.sendMessage` | no | State-mutating Genie conversation |
| `lakebase.query` | no | Already gated by `exposeAsAgentTool`; auto-inherit stays closed as defense-in-depth |

Third-party `ToolProvider` plugins that don't expose a `toolkit()` method are also skipped from the auto-inherit path — their tools must be wired via `tools:` explicitly. At setup the agents plugin logs what each agent inherited and what was skipped so the posture is visible:

```
[agents] [agent support] auto-inherited 2 tool(s): analytics.query, files.uploads.read
[agents] [agent support] auto-inherit skipped 3 tool(s) not marked autoInheritable: files(2), genie(1). Wire them explicitly via `tools:` if needed.
```

### SQL agent tools

Two built-in agent tools can execute SQL on behalf of the LLM: `analytics.query` (against the Databricks SQL warehouse) and the opt-in `lakebase.query` (against a Lakebase Postgres database). Both have distinct safety postures because they run with different privileges.

**`analytics.query`** runs under the caller's OBO token (the end user's Databricks credentials). Its `readOnly: true` annotation is enforced at execution time — statements are tokenized and only `SELECT`, `WITH`, `SHOW`, `EXPLAIN`, `DESCRIBE`, and `DESC` are accepted. Writes, DDL, and stacked statements are rejected before the request reaches the warehouse:

```ts
// accepted
analytics.query({ query: "SELECT * FROM main.sales.orders WHERE created_at > current_date() - 7" })

// rejected at the plugin, never reaches the warehouse
analytics.query({ query: "UPDATE main.sales.orders SET status = 'cancelled'" })
analytics.query({ query: "SELECT 1; DROP TABLE main.sales.orders" })
```

**`lakebase.query`** is **not registered as an agent tool by default**. Enabling it is an explicit decision because the Lakebase pool is bound to the application's service principal: an agent with access to this tool can execute SQL as the SP regardless of which end user initiated the request. Opt in with an acknowledgement flag:

```ts
lakebase({
  exposeAsAgentTool: {
    iUnderstandRunsAsServicePrincipal: true,
    readOnly: true, // default
  },
});
```

With `readOnly: true` (default), the same SQL classifier as `analytics.query` applies, and the accepted statement is additionally wrapped in `BEGIN READ ONLY; … ROLLBACK;` so the Postgres server rejects any write that slips past the classifier (e.g., a `SELECT` over a side-effecting function). The tool annotation is `{ effect: "read" }`.

With `readOnly: false`, the tool accepts arbitrary SQL and is annotated `{ effect: "destructive" }`. The `destructive` effect triggers the human-in-the-loop approval gate (below) on every invocation.

### Human-in-the-loop approval for mutating tools

Any tool annotated with a mutating effect — `effect: "write" | "update" | "destructive"` (preferred) or the legacy `destructive: true` boolean — requires explicit user approval before execution. Secure by default: set `approval.requireForDestructive: false` only for fully autonomous back-office agents running in single-user contexts.

Flow:

1. Before running the tool, the agents plugin emits an `appkit.approval_pending` SSE event carrying the pending call's `approval_id`, `stream_id`, `tool_name`, `args`, and `annotations`.
2. The chat client renders an approval prompt (see the reference app's approval card).
3. The same user who initiated the stream posts the decision to `POST /api/agents/approve`:

   ```http
   POST /api/agents/approve
   Content-Type: application/json
   X-Forwarded-User: <end-user id>
   X-Forwarded-Access-Token: <OBO token>

   { "streamId": "...", "approvalId": "...", "decision": "approve" | "deny" }
   ```
4. If approved, the tool executes normally and the stream continues. If denied, the adapter receives the string `"Tool execution denied by user approval gate (tool: <name>)."` as the tool output and the LLM can apologise / replan. If no decision arrives within `approval.timeoutMs` (default 60 s), the gate auto-denies.

The route enforces that the decider is the stream owner: an approve from a different `x-forwarded-user` returns `403`. Cancelling the stream via `POST /api/agents/cancel` denies every pending approval on that stream.

### Resource limits

The plugin enforces a handful of caps to protect a single-instance deployment from runaway prompts, misbehaving clients, or prompt-injected delegation cycles. Some are static (enforced by the request schema) and some are configurable via `agents({ limits: { ... } })`.

**Static caps** (applied at `POST /chat`, `POST /invocations`, and `POST /responses` request parsing):

| Field | Cap | Why |
|---|---|---|
| `chat.message` | 64 000 characters | ~16k tokens; larger bodies are almost certainly abuse. |
| `invocations.input` string | 64 000 characters | Same reasoning. |
| `invocations.input` array | 100 items | Prevents a single request seeding hundreds of messages into the thread store. |
| `invocations.input[].content` string | 64 000 characters | Per-seeded-message cap. |
| `invocations.input[].content` array | 100 items | Per-seeded-message cap. |

**Configurable caps** (defaults shown):

```ts
agents({
  limits: {
    maxConcurrentStreamsPerUser: 5,  // HTTP 429 + Retry-After when exceeded
    maxToolCalls: 50,                // aborts the run if the budget is exhausted
    maxSubAgentDepth: 3,             // rejects sub-agent recursion beyond this
    toolCallTimeoutMs: 300_000,      // per-tool-call timeout (5 min; cold SQL/Genie headroom)
  },
});
```

The `maxToolCalls` budget is shared across the top-level adapter and every sub-agent it delegates to, so a prompt-injected fan-out cannot escape by going deeper. `maxConcurrentStreamsPerUser` is per-user, not global — one user hitting their limit does not affect others.

## Runtime API

After `createApp`, the plugin exposes:

```ts
appkit.agents.list();               // => ["support", "researcher", ...]
appkit.agents.get("support");       // => RegisteredAgent | null
appkit.agents.getDefault();         // => "support"
appkit.agents.register(name, def);  // dynamic registration
appkit.agents.reload();             // re-scan the directory
appkit.agents.getThreads(userId);   // list user's threads
```

## Frontmatter schema

| Key | Type | Notes |
|---|---|---|
| `endpoint` | string | Model serving endpoint name. Shortcut for `model`. |
| `model` | string | Same as `endpoint`; either works. |
| `tools` | array | Unified tool list. Entries are `plugin:<name>` / `plugin:<name>: [t1, t2]` / `plugin:<name>: { only, except, rename, prefix }` for plugin tools, or a bare `<key>` resolved against `agents({ tools: {...} })` for ambient tools. See "Level 2: scope tools in frontmatter" above for examples. |
| `skills` | array | Names of global skills (shared `skills/` pool or catalog volume) to make visible to this agent. Per-agent skills under `<id>/skills/` are always visible. See [Skills](#skills). |
| `default` | boolean | First agent id (sorted order) with `default: true` becomes the default agent. |
| `agents` | array | Sub-agent ids (sibling folders) to delegate to; each becomes an `agent-<id>` tool. Resolves against other markdown and code agents. |
| `maxSteps` | number | Adapter max-step hint. |
| `maxTokens` | number | Adapter max-token hint. |
| `generationParams` | object | Adapter generation params (e.g. `temperature`, `top_p`) passed through when AppKit builds the adapter. |
| `baseSystemPrompt` | false \| string | Per-agent override. `false` disables the AppKit base prompt. |
| `ephemeral` | boolean | If `true`, the thread created for a chat request against this agent is deleted from `ThreadStore` after the stream finishes. Use for stateless one-shot agents (e.g. autocomplete) so history does not accumulate or contaminate future calls. Defaults to `false`. |

Unknown keys are logged and ignored. Invalid YAML and missing plugin/tool references throw at boot.
