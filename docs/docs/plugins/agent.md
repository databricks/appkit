---
sidebar_position: 7
---

# Agent plugin

Adds AI agent capabilities to your AppKit application. All requests and responses follow the [OpenAI Responses API](https://platform.openai.com/docs/api-reference/responses) format for both payloads and SSE streaming events. By default, the plugin runs a standard ReAct agent internally, but you can replace it with your own implementation via `AgentInterface`.

**Key features:**

- Built-in ReAct agent with tool-use loop — no framework code to write
- OpenResponses-aligned tool definitions (JSON Schema parameters)
- Databricks hosted tools: Genie spaces, Vector Search, custom and external MCP servers
- SSE streaming with real-time text deltas and tool call visibility
- Bring-your-own agent via `AgentInterface`
- Ready-to-use React chat component

## Supported model endpoints

The `model` config (or `DATABRICKS_MODEL` env var) should point to a **foundation model or external model endpoint** with the **chat** task type — any endpoint that supports the [chat completion query format](https://docs.databricks.com/aws/en/machine-learning/model-serving/score-foundation-models#chat-completion-model-query). This includes Databricks-hosted foundation models (e.g. `databricks-claude-sonnet-4-5`, `databricks-meta-llama-3-3-70b-instruct`) and external model endpoints.

## Basic usage

```ts
import { agent, createApp, server } from "@databricks/appkit";

await createApp({
  plugins: [
    server(),
    agent({
      model: "databricks-claude-sonnet-4-5",
    }),
  ],
});
```

## Configuration options

| Option            | Type             | Default                               | Description                                                                   |
| ----------------- | ---------------- | ------------------------------------- | ----------------------------------------------------------------------------- |
| `model`           | `string`         | `DATABRICKS_MODEL` env var            | Databricks model serving endpoint name                                        |
| `systemPrompt`    | `string`         | `"You are a helpful AI assistant..."` | System prompt injected at the start of every conversation                     |
| `tools`           | `AgentTool[]`    | `[]`                                  | Tools to register (function tools and/or hosted tools)                        |
| `temperature`     | `number`         | `0.1`                                 | Sampling temperature (0.0–1.0)                                                |
| `maxTokens`       | `number`         | `2000`                                | Max tokens to generate                                                        |
| `useResponsesApi` | `boolean`        | `false`                               | Use the Responses API instead of Chat Completions for the upstream model call |
| `agentInstance`   | `AgentInterface` | —                                     | Bring-your-own agent (skips built-in agent setup)                             |

All options except `agentInstance` and `systemPrompt` are ignored when `agentInstance` is provided.

## Environment variables

| Variable           | Description                                                           |
| ------------------ | --------------------------------------------------------------------- |
| `DATABRICKS_MODEL` | Model serving endpoint name (fallback when `model` config is omitted) |

## Tools

Tools are passed via the `tools` config array. There are two kinds: **function tools** (local, with an execute handler) and **hosted tools** (resolved to Databricks-managed MCP servers).

### Function tools

Define tools as plain objects following the [OpenResponses FunctionTool](https://platform.openai.com/docs/api-reference/responses/create#responses-create-tools) convention. Parameters use standard JSON Schema:

```ts
import type { FunctionTool } from "@databricks/appkit";

const weatherTool: FunctionTool = {
  type: "function",
  name: "get_weather",
  description: "Get the current weather for a location",
  parameters: {
    type: "object",
    properties: {
      location: {
        type: "string",
        description: "City name, e.g. 'San Francisco'",
      },
    },
    required: ["location"],
  },
  execute: async ({ location }) => {
    return `Weather in ${location}: sunny, 72°F`;
  },
};

agent({
  model: "databricks-claude-sonnet-4-5",
  tools: [weatherTool],
});
```

### Hosted tools

Databricks-hosted tools are declared as typed objects and resolved to managed MCP server connections at startup:

```ts
agent({
  model: "databricks-claude-sonnet-4-5",
  tools: [
    // Genie space
    { type: "genie", genie_space: { id: "01ABCDEF12345678" } },

    // Vector Search index (three-part name: catalog.schema.index)
    {
      type: "vector_search_index",
      vector_search_index: { name: "main.default.my_index" },
    },

    // Custom MCP server (Databricks App)
    {
      type: "custom_mcp_server",
      custom_mcp_server: { app_name: "my-mcp-app", app_url: "my-mcp-app" },
    },

    // External MCP server (UC Connection)
    {
      type: "external_mcp_server",
      external_mcp_server: { connection_name: "my-connection" },
    },
  ],
});
```

| Hosted tool type      | Description                       | Required fields                                           |
| --------------------- | --------------------------------- | --------------------------------------------------------- |
| `genie`               | AI/BI Genie space                 | `genie_space.id`                                          |
| `vector_search_index` | Unity Catalog Vector Search index | `vector_search_index.name` (catalog.schema.index)         |
| `custom_mcp_server`   | Databricks App exposing MCP       | `custom_mcp_server.app_name`, `custom_mcp_server.app_url` |
| `external_mcp_server` | External MCP via UC Connection    | `external_mcp_server.connection_name`                     |

### Adding tools after startup

Tools can also be added after app creation:

```ts
const appkit = await createApp({
  plugins: [server(), agent({ model: "databricks-claude-sonnet-4-5" })],
});

await appkit.agent.addTools([weatherTool, timeTool]);
```

This rebuilds the underlying agent with the new tool set.

## HTTP endpoint

The agent plugin exposes a single endpoint (mounted under `/api/agent`):

- `POST /api/agent` — Invoke the agent (streaming or non-streaming)

### Request format

The endpoint accepts [Responses API](https://platform.openai.com/docs/api-reference/responses/create) payloads:

```json
{
  "input": [{ "role": "user", "content": "What's the weather in SF?" }],
  "stream": true
}
```

`input` can be a plain string (treated as a single user message) or an array of message objects with `role` and `content`.

### Streaming response (SSE)

When `stream: true` (default), the response is an SSE stream emitting these event types:

| Event type                   | Description                                            |
| ---------------------------- | ------------------------------------------------------ |
| `response.output_item.added` | A new output item (message, tool call, or tool result) |
| `response.output_text.delta` | Incremental text chunk from the assistant              |
| `response.output_item.done`  | An output item is complete                             |
| `response.completed`         | The full response is done                              |
| `error`                      | Error details                                          |
| `response.failed`            | The response failed                                    |

The stream ends with `data: [DONE]`.

### Non-streaming response

When `stream: false`, the response is a JSON object:

```json
{
  "output": [
    { "type": "message", "role": "assistant", "content": [...] }
  ]
}
```

### Routing convention

Databricks Apps expects an agent endpoint at `POST /invocations`. Use `server.extend()` to rewrite:

```ts
const appkit = await createApp({
  plugins: [
    server({ autoStart: false }),
    agent({ model: "databricks-claude-sonnet-4-5" }),
  ],
});

appkit.server
  .extend((app) => {
    app.post("/invocations", (req, res) => {
      req.url = "/api/agent";
      app(req, res);
    });
  })
  .start();
```

## Programmatic access

The plugin exports `invoke` and `stream` for server-side use:

```ts
const appkit = await createApp({
  plugins: [
    server(),
    agent({ model: "databricks-claude-sonnet-4-5", tools: [weatherTool] }),
  ],
});

// Simple invoke — returns the assistant's text
const reply = await appkit.agent.invoke([
  { role: "user", content: "What's the weather in SF?" },
]);
console.log(reply); // "Weather in San Francisco: sunny, 72°F"

// Stream Responses API events
for await (const event of appkit.agent.stream([
  { role: "user", content: "What's the weather in SF?" },
])) {
  if (event.type === "response.output_text.delta") {
    process.stdout.write(event.delta);
  }
}
```

## Bring your own agent

The built-in agent covers common use cases, but you can replace it entirely. Implement the [`AgentInterface`](../api/appkit/Interface.AgentInterface.md) and pass it as `agentInstance`:

```ts
import type {
  AgentInterface,
  InvokeParams,
  ResponseOutputItem,
  ResponseStreamEvent,
} from "@databricks/appkit";

class MyAgent implements AgentInterface {
  async invoke(params: InvokeParams): Promise<ResponseOutputItem[]> {
    // your logic here
  }

  async *stream(params: InvokeParams): AsyncGenerator<ResponseStreamEvent> {
    // your streaming logic here
  }
}

agent({ agentInstance: new MyAgent() });
```

When `agentInstance` is provided, the plugin acts as a thin HTTP adapter — all model, tool, and prompt configuration is ignored.

## Frontend components

The `@databricks/appkit-ui` package provides React components for agent chat.

### AgentChat

A full-featured chat interface with SSE streaming, tool call display, and auto-scroll:

```tsx
import { AgentChat } from "@databricks/appkit-ui/react";

function ChatPage() {
  return (
    <div style={{ height: 600 }}>
      <AgentChat
        invokeUrl="/invocations"
        placeholder="Type a message..."
        emptyMessage="Send a message to start."
      />
    </div>
  );
}
```

| Prop           | Type     | Default                      | Description                                 |
| -------------- | -------- | ---------------------------- | ------------------------------------------- |
| `invokeUrl`    | `string` | `"/invocations"`             | POST URL for agent invocations              |
| `placeholder`  | `string` | `"Type a message..."`        | Input field placeholder text                |
| `emptyMessage` | `string` | `"Send a message to start."` | Empty state message                         |
| `className`    | `string` | —                            | Additional CSS class for the root container |

### useAgentChat hook

For custom chat UIs, use the `useAgentChat` hook directly:

```tsx
import { useAgentChat } from "@databricks/appkit-ui/react";

function CustomChat() {
  const {
    displayMessages,
    loading,
    input,
    setInput,
    handleSubmit,
    isStreamingText,
  } = useAgentChat({ invokeUrl: "/invocations" });

  return (
    <form onSubmit={handleSubmit}>
      {displayMessages.map((msg, i) => (
        <div key={i}>
          <strong>{msg.role}:</strong>
          {msg.role === "user"
            ? msg.content
            : msg.parts?.map((p, j) =>
                p.type === "text" ? <span key={j}>{p.content}</span> : null
              )}
        </div>
      ))}
      <input
        value={input}
        onChange={(e) => setInput(e.target.value)}
        disabled={loading}
      />
      <button type="submit" disabled={loading || !input.trim()}>
        Send
      </button>
    </form>
  );
}
```

**Return type:**

| Field             | Type                      | Description                                        |
| ----------------- | ------------------------- | -------------------------------------------------- |
| `messages`        | `ChatMessage[]`           | Full message history                               |
| `displayMessages` | `ChatMessage[]`           | Messages including current streaming state         |
| `loading`         | `boolean`                 | True while a request is in flight                  |
| `input`           | `string`                  | Current input field value                          |
| `setInput`        | `(value: string) => void` | Update input                                       |
| `handleSubmit`    | `(e: FormEvent) => void`  | Submit handler                                     |
| `isStreamingText` | `boolean`                 | True when the assistant is actively streaming text |
