# Brainstorm: Model Serving Plugin

**Date:** 2026-03-23
**Status:** Ready for planning

## What We're Building

A **Model Serving plugin** for AppKit that provides authenticated access to Databricks Model Serving endpoints. The plugin acts as a thin proxy — handling authentication (service principal or OBO) and leveraging AppKit's built-in interceptor chain (retry, timeout, telemetry, cache) — while preserving the standard OpenAI-compatible API formats for chat completions and embeddings.

### Scope

- **Chat/LLM completions** (OpenAI-compatible `messages` format)
- **Embeddings** (same serving infrastructure, `input` format)
- **Both streaming (SSE) and non-streaming** responses for chat
- **One required endpoint** (chat/LLM) + **one optional endpoint** (embeddings)
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

1. **One required + one optional endpoint** — The plugin requires `DATABRICKS_SERVING_ENDPOINT` as the primary endpoint for all operations (chat, embeddings, or agent). Optionally, `DATABRICKS_SERVING_ENDPOINT_EMBEDDING` overrides the endpoint used for embeddings when a separate model is needed (e.g., `databricks-gte-large-en` for embeddings while using `databricks-meta-llama-3-3-70b-instruct` for chat). `chat()`/`chatStream()` always uses the primary. `embed()` uses the embedding override if set, otherwise falls back to the primary. This supports chat-only, embedding-only, and chat+separate-embedding use cases. Aligns with Databricks Apps `valueFrom` pattern and CLI `apps init` flow.

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
  "required": [
    {
      "type": "serving_endpoint",
      "alias": "Serving Endpoint",
      "resourceKey": "serving-endpoint",
      "description": "Your primary model endpoint (chat, embeddings, or agent)",
      "permission": "CAN_QUERY",
      "fields": {
        "name": {
          "env": "DATABRICKS_SERVING_ENDPOINT",
          "description": "Name of the serving endpoint"
        }
      }
    }
  ],
  "optional": [
    {
      "type": "serving_endpoint",
      "alias": "Separate Embedding Endpoint",
      "resourceKey": "serving-endpoint-embedding",
      "description": "Only needed if you use a different model for embeddings than your primary endpoint",
      "permission": "CAN_QUERY",
      "fields": {
        "name": {
          "env": "DATABRICKS_SERVING_ENDPOINT_EMBEDDING",
          "description": "Name of the embedding serving endpoint"
        }
      }
    }
  ]
}
```

**Behavior:** `chat()`/`chatStream()` always uses the primary endpoint. `embed()` uses `DATABRICKS_SERVING_ENDPOINT_EMBEDDING` if configured, otherwise falls back to `DATABRICKS_SERVING_ENDPOINT`.

## CLI Integration (`apps init`)

The serving plugin integrates seamlessly with the CLI `apps init` flow — no CLI code changes needed:

1. **Plugin selection:** User selects "serving" from the feature list
2. **Required resource prompt:** "Select Serving Endpoint" — user picks from workspace endpoints (paged dropdown)
3. **Optional resource prompt:** "Configure Embedding Endpoint? (optional)" — user can skip or pick a second endpoint
4. **Bundle generation:** CLI generates `databricks.yml` with resource entries and `app.yaml` with `valueFrom` env var mapping
5. **Template generation:** `.env` populated with endpoint names, `.env.example` shows both vars (optional one commented out)

The CLI's existing `serving_endpoint` support (`PromptForServingEndpoint`, `ListServingEndpoints`, prefetching, bundle generation) handles all of this automatically when the manifest declares the resources correctly.

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
