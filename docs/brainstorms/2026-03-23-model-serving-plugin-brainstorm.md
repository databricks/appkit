# Brainstorm: Model Serving Plugin

**Date:** 2026-03-23
**Status:** Ready for planning

## What We're Building

A **Model Serving plugin** for AppKit that provides authenticated access to Databricks Model Serving endpoints. The plugin acts as a thin proxy — handling authentication (service principal or OBO) and leveraging AppKit's built-in interceptor chain (retry, timeout, telemetry, cache) — while preserving the standard OpenAI-compatible API formats for chat completions and embeddings.

### Scope

- **Chat/LLM completions** (OpenAI-compatible `messages` format)
- **Embeddings** (same serving infrastructure, `input` format)
- **Both streaming (SSE) and non-streaming** responses for chat
- **Two optional endpoint configs** — one for chat, one for embeddings (at least one required)
- **Programmatic API** (`exports()`) for server-side use + **HTTP routes** for frontend consumption

### Out of Scope (for v1)

- Custom ML model scoring (dataframe_split/inputs format)
- ChatAgent / ResponsesAgent endpoint types (natural future extension — see `app-templates/e2e-chatbot-app` for reference patterns)
- Endpoint management (create/update/delete/start/stop)
- Conversation/session management
- Response normalization or custom abstractions

## Why This Approach

**Thin Proxy** was chosen over a higher-level abstraction because:

1. **YAGNI** — The OpenAI-compatible format is already well-known; wrapping it adds complexity without clear value
2. **Interceptors provide the value** — Retry, timeout, caching, and telemetry come free from the Plugin base class. Note: caching is primarily useful for embeddings (same input = same vector); chat completions are typically not cached
3. **Less maintenance** — Passthrough means less code to break when the upstream API evolves
4. **Composability** — Other plugins or app code can build higher-level abstractions on top if needed

## Key Decisions

1. **Two optional endpoint env vars** — The plugin supports two optional env vars: `DATABRICKS_SERVING_CHAT_ENDPOINT` and `DATABRICKS_SERVING_EMBEDDING_ENDPOINT`. Each enables its respective API surface (`chat`/`chatStream` and `embed`). At least one must be configured. This avoids forcing multi-instance registration when a single app needs both chat and embeddings (the common "agents on apps" case).

2. **OpenAI-compatible passthrough** — Request and response formats match the Databricks chat completions API (which is OpenAI-compatible). No custom request/response types beyond what's needed for TypeScript typing.

3. **Streaming via AppKit's StreamManager** — SSE streaming uses the existing `executeStream()` infrastructure. The plugin proxies the upstream SSE stream from the serving endpoint to the client.

4. **Auth: service principal by default, OBO supported** — Like other plugins, default execution uses the app's service principal. `asUser(req)` enables on-behalf-of execution where the user's token is forwarded.

5. **Embeddings included** — The embeddings API uses the same serving infrastructure and adds minimal code. Including it makes the plugin useful for "agents on apps" / RAG use cases where both chat and embeddings are needed from the same serving layer.

## API Surface

### Programmatic API (exports)

```typescript
// Non-streaming
const response = await appkit.serving.chat({
  messages: [{ role: "user", content: "Hello" }],
  temperature: 0.7,
  max_tokens: 256,
});

// Streaming
const stream = appkit.serving.chatStream({
  messages: [{ role: "user", content: "Hello" }],
});

// Embeddings
const embeddings = await appkit.serving.embed({
  input: "Search query text",
});

// OBO (on-behalf-of user)
const response = await appkit.serving.asUser(req).chat({ messages: [...] });
```

### HTTP Routes

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/serving/chat` | Non-streaming chat completion |
| `POST` | `/api/serving/chat/stream` | Streaming chat completion (SSE) |
| `POST` | `/api/serving/embeddings` | Generate embeddings |

### Configuration

**Manifest resources:**
```json
{
  "required": [],
  "optional": [
    {
      "type": "serving_endpoint",
      "alias": "Chat Endpoint",
      "resourceKey": "serving-chat-endpoint",
      "description": "Databricks serving endpoint for chat completions",
      "fields": {
        "name": {
          "env": "DATABRICKS_SERVING_CHAT_ENDPOINT",
          "description": "Name of the chat serving endpoint"
        }
      }
    },
    {
      "type": "serving_endpoint",
      "alias": "Embedding Endpoint",
      "resourceKey": "serving-embedding-endpoint",
      "description": "Databricks serving endpoint for embeddings",
      "fields": {
        "name": {
          "env": "DATABRICKS_SERVING_EMBEDDING_ENDPOINT",
          "description": "Name of the embedding serving endpoint"
        }
      }
    }
  ]
}
```

**Validation:** At least one endpoint must be configured. Calling `chat()` without a chat endpoint or `embed()` without an embedding endpoint throws a clear error.

## Demo & Template Strategy

### Dev-Playground: "Paste & Ask" RAG Page

A demo page that showcases both `chatStream()` and `embed()` working together:
1. User pastes text chunks into a text area
2. App embeds them via `embed()`, stores vectors in-memory (per-session, server-side `Map`)
3. User asks a question in a chat box
4. App embeds the question, finds top-K similar chunks via cosine similarity
5. Sends context + question to `chatStream()`, streams the answer with sources

**Why:** Demonstrates plugin composition, both APIs in action, and a real use case (RAG). More compelling than another chat box (which Genie already covers).

### Template: Simple Streaming Chat Page

A minimal chat page with streaming responses — conditionally included when the serving plugin is selected. No RAG, no embeddings — just `chatStream()` with conversation history on the frontend.

**Why:** Templates should be minimal starting points. RAG can be added by referencing the dev-playground pattern.

### Future Enhancement: Lakebase pgvector

The in-memory vector store could be swapped for Lakebase with pgvector extension for persistence and larger doc sets. A `VectorStore` interface abstraction would make this a drop-in upgrade. Deferred for now.

## Open Questions

_(None — all key decisions resolved during brainstorm)_

## References

- [Databricks Model Serving docs](https://docs.databricks.com/aws/en/machine-learning/model-serving/create-manage-serving-endpoints)
- [Foundation model REST API reference](https://docs.databricks.com/aws/en/machine-learning/foundation-model-apis/api-reference)
- Existing plugin patterns: Analytics, Files, Genie, Lakebase
