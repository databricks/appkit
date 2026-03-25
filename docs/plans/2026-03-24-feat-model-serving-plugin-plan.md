---
title: "feat: Add Model Serving plugin"
type: feat
status: active
date: 2026-03-24
origin: docs/brainstorms/2026-03-23-model-serving-plugin-brainstorm.md
deepened: 2026-03-24
---

# feat: Add Model Serving Plugin

## Enhancement Summary

**Deepened on:** 2026-03-24
**Research agents used:** TypeScript reviewer, Performance oracle, Security sentinel, Architecture strategist, Code simplicity reviewer, Pattern recognition specialist, SSE streaming best practices researcher, Databricks SDK researcher

### Key Improvements
1. **Type safety hardened** — removed unsafe index signature, added string literal unions for roles, fully specified response types
2. **Security hardened** — parameter allowlist instead of open passthrough, endpoint name validation, input size limits, error sanitization
3. **Performance grounded** — connection pool configuration, proper SSE frame parser, AbortSignal chain, LRU cache bounds
4. **Simplified** — collapsed to 2 implementation phases, dropped separate connector directory, generic error passthrough instead of per-code mapping
5. **SDK confirmed** — `@databricks/sdk-experimental` does NOT support streaming for serving endpoints; raw `fetch()` is required

### New Considerations Discovered
- AppKit has no upstream SSE parser — need to create one for proxy scenarios
- `SSEWriter.writeEvent()` doesn't handle backpressure (known gap, not blocking for v1)
- Resource model simplified: one required (chat) + one optional (embedding) — aligns with CLI `apps init` flow and Databricks Apps `valueFrom` pattern

---

## Overview

Add a new `serving` plugin to AppKit that provides authenticated access to Databricks Model Serving endpoints for chat completions (streaming + non-streaming) and embeddings. The plugin acts as a thin proxy — leveraging AppKit's interceptor chain (retry, timeout, telemetry, cache) while preserving the standard OpenAI-compatible API format.

## Problem Statement / Motivation

Currently, apps that need to interact with Databricks Model Serving (e.g., the `e2e-chatbot-app` template) must handle authentication, streaming SSE parsing, retry logic, and error handling manually — often with ~300+ lines of boilerplate. AppKit already provides all of these capabilities through its plugin interceptor chain, but has no serving plugin to leverage them.

## Proposed Solution

A `serving` plugin following the established plugin patterns (Genie for streaming, Files for optional multi-resource config). The plugin is a thin proxy: requests are validated minimally and forwarded to Databricks, responses are passed through in OpenAI-compatible format.

### Design Decisions (from brainstorm)

1. **One required + one optional endpoint** — `DATABRICKS_SERVING_ENDPOINT` (required, chat/LLM) and `DATABRICKS_SERVING_EMBEDDING_ENDPOINT` (optional, embeddings). Aligns with CLI `apps init` flow and Databricks Apps `valueFrom` resource pattern. _(see brainstorm: Key Decision 1)_
2. **OpenAI-compatible passthrough** — no custom request/response types beyond TypeScript typing. _(see brainstorm: Key Decision 2)_
3. **Streaming via AppKit's executeStream()** — connector returns `AsyncGenerator<ChatCompletionChunk>`, consumed by StreamManager. Matches Genie plugin pattern. _(see brainstorm: Key Decision 3)_
4. **OBO by default for HTTP routes** — matching Genie and Files plugin conventions. Programmatic API uses service principal by default, with `asUser(req)` for OBO. _(see brainstorm: Key Decision 4, refined by SpecFlow)_
5. **Embeddings included** — minimal extra code, enables "agents on apps" / RAG use cases. _(see brainstorm: Key Decision 5)_

## Technical Considerations

### File Structure

```
packages/appkit/src/plugins/serving/
  index.ts                  - Re-exports
  serving.ts                - Plugin class with inline fetch logic + toPlugin export
  types.ts                  - IServingConfig, request/response types (OpenAI-compatible)
  defaults.ts               - Interceptor defaults (per-operation)
  manifest.json             - Plugin manifest with optional serving_endpoint resources
  tests/
    serving.test.ts         - Unit tests
```

#### Research Insights

**Simplification (from simplicity review):** Dropped the separate `connectors/serving/` directory. The serving connector is a thin `fetch()` wrapper (~30 LOC per method). Inline the fetch logic as private methods in `serving.ts`, or extract a single `_invoke()` helper. If complexity grows later, split into a connector then. Note: the architecture review recommended keeping the connector for pattern consistency — this is a conscious trade-off favoring simplicity for a thin proxy.

**Pattern compliance (from pattern review):**
- Config interface must be named `IServingConfig` (not `ServingConfig`) — all existing configs use the `I` prefix
- Main file named `serving.ts` (not `plugin.ts`) — matches Genie, Analytics, Lakebase convention
- Must include `$schema` field in manifest
- Static manifest typed as `PluginManifest<"serving">`
- Export const named `serving` (lowercase) via `toPlugin(ServingPlugin)`

**Export wiring (required):**
- Add `export * from "./serving"` to `packages/appkit/src/plugins/index.ts`
- Add `serving` to the named export in `packages/appkit/src/index.ts`

### Interceptor Defaults

| Operation | Timeout | Retry | Cache |
|-----------|---------|-------|-------|
| `chat()` | 120s | disabled (expensive, non-deterministic) | disabled |
| `chatStream()` | 120s | disabled (stateful connection) | disabled |
| `embed()` | 30s | 3 attempts with backoff (idempotent, cheap) | TTL 3600s, maxEntries: 10000 |

#### Research Insights

**Naming convention (from pattern review):** Follow the Files plugin convention for defaults naming: `SERVING_CHAT_DEFAULTS`, `SERVING_STREAM_DEFAULTS`, `SERVING_EMBED_DEFAULTS` (SCREAMING_SNAKE_CASE with plugin prefix).

**Cache bounds (from performance review):** Add `maxEntries: 10000` with LRU eviction to the embedding cache. Without bounds, unique user inputs accumulate stale entries for the full TTL hour. Cache key uses `crypto.createHash('sha256')` on `JSON.stringify(input)` — deterministic, handles array ordering, O(n) in input size.

**Cache key:** `["serving:embed", endpointName, sha256(JSON.stringify(input)), executorKey]` — includes executor key to prevent cross-user cache leaks in OBO mode.

### Streaming Architecture

The plugin's `_streamChat()` method:
1. Sends `POST /serving-endpoints/{name}/invocations` with `stream: true` to Databricks
2. Consumes the upstream SSE response via `response.body` (ReadableStream)
3. Parses SSE frames using a layered generator approach, yielding `ChatCompletionChunk` objects
4. AppKit's `executeStream()` re-wraps these into its own SSE envelope (with connection IDs, event ring buffer, heartbeat)

#### Research Insights

**SSE parser implementation (from streaming research):** TCP chunks do NOT align with SSE event boundaries. Must buffer across chunks and split on `\n\n`:

```typescript
async function* parseSSEStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<ChatCompletionChunk, void, undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop() || '';

      for (const part of parts) {
        for (const line of part.split('\n')) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') return;
            try {
              yield JSON.parse(data);
            } catch {
              // Log malformed chunk, don't kill the stream
              continue;
            }
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
```

**Anti-patterns to avoid:**
- Do NOT assume 1 `read()` = 1 SSE event
- Do NOT use string concatenation for partial buffers in hot loops (use array fragments + join for very long streams)
- Do NOT throw on individual malformed JSON chunks — log and continue

**AbortSignal chain (from performance + streaming research):**

```
Client disconnects (req 'close' event)
  → AbortController.abort()
    → fetch() upstream abort (cancels TCP connection)
    → AsyncGenerator return() (finally block → reader.releaseLock())
    → StreamManager cleanup (ring buffer disposal)
```

Use `AbortSignal.any()` (Node.js 20+) to combine client-disconnect and timeout signals.

**`X-Accel-Buffering: no` header (from streaming research):** Add to SSE response headers to prevent nginx/cloud LB buffering. AppKit's `SSEWriter.setupHeaders()` already sets `Content-Encoding: none` but not this header.

### HTTP Calls to Databricks

Use raw `fetch()` with SDK auth. **Confirmed: `@databricks/sdk-experimental` v0.16.0 does NOT support streaming for serving endpoints** — `servingEndpoints.query()` always returns `Promise<QueryEndpointResponse>`, and the SDK lacks `ChatCompletionChunk` types.

```typescript
const client = getWorkspaceClient();
const url = new URL(
  `/serving-endpoints/${encodeURIComponent(endpointName)}/invocations`,
  client.config.host,
);
const headers: Record<string, string> = { 'Content-Type': 'application/json' };
await client.config.authenticate(headers);
const response = await fetch(url, {
  method: 'POST',
  headers,
  body: JSON.stringify(payload),
  signal,
});
```

#### Research Insights

**URL construction (from TypeScript + security reviews):** Use `new URL()` constructor with `encodeURIComponent()` instead of string interpolation. Prevents path traversal if endpoint name ever contains special characters.

**Connector accepts WorkspaceClient per-call (from architecture review):** Even though we inline the fetch logic in the plugin, the `getWorkspaceClient()` call must happen in the plugin (not stored), preserving the OBO chain: `Plugin.asUser()` → `runInUserContext()` → `getWorkspaceClient()` returns user-scoped client.

**Connection pooling (from performance review):** Node.js `fetch()` (undici) defaults to ~10 connections per origin. Under 20+ concurrent requests (common for chat apps), this causes connection starvation. Configure an explicit undici `Agent`:

```typescript
import { Agent } from 'undici';

const servingAgent = new Agent({
  connections: 100,
  pipelining: 1,        // disable for SSE streams
  keepAliveTimeout: 30_000,
});

// Pass as dispatcher to fetch()
const response = await fetch(url, { dispatcher: servingAgent, signal, ... });
```

Consider separate pools for streaming (long-lived) vs. non-streaming (short-lived) to prevent head-of-line blocking. Note: connection pool tuning is a v2 optimization — default `fetch()` is sufficient for v1 with <20 concurrent users. Add a `// TODO` comment for high-concurrency scenarios.

### Request Validation

Minimal validation with security guardrails:

#### Research Insights

**Parameter allowlist (from security review — CRITICAL):** Replace the `[key: string]: unknown` index signature with an explicit allowlist of known OpenAI parameters. This prevents prototype pollution, internal parameter injection, and payload size abuse:

```typescript
const ALLOWED_CHAT_PARAMS = new Set([
  'messages', 'temperature', 'max_tokens', 'top_p', 'stop',
  'n', 'presence_penalty', 'frequency_penalty', 'logit_bias',
  'user', 'response_format', 'seed', 'tools', 'tool_choice',
]);
```

**Input bounds (from security review):**
- `messages`: non-empty array, max 256 messages, each content max 128K chars
- `input` (embeddings): must be present, max 100 items if array, each max 32K chars
- Express body-parser size limit: set to 1MB for serving routes (chat with long history can exceed 100KB default)

**Endpoint name validation (from security review — defense in depth):**
```typescript
const ENDPOINT_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;
```
Validate at startup in `setup()`. Even though values come from env vars, this prevents SSRF if the pattern is ever extended.

### Error Handling

#### Research Insights

**Generic passthrough (from simplicity review):** The original plan mapped 5 status codes individually, but this is identity mapping — the upstream code IS the correct downstream code. Use a single generic handler:

```typescript
if (!response.ok) {
  const body = await response.json().catch(() => ({}));
  const message = typeof body === 'object' && body !== null && 'message' in body
    ? String((body as Record<string, unknown>).message).slice(0, 200)
    : response.statusText;
  res.status(response.status).json({ error: message, plugin: this.name });
  return;
}
```

**Error sanitization (from security review):** Truncate upstream error messages to 200 chars max. Databricks errors may contain internal hostnames, stack traces, or config details. Use generic messages for 5xx errors:

```typescript
if (response.status >= 500) {
  res.status(502).json({ error: 'Model serving request failed.', plugin: this.name });
  return;
}
```

**Mid-stream errors:** Emit SSE error event matching StreamManager's `SSEErrorCode` pattern. Categorize: `UPSTREAM_ERROR` for Databricks failures, `TIMEOUT` for signal abort.

### Per-Method Endpoint Validation

The chat endpoint is always available (required resource). The embedding endpoint needs validation at call time:
```typescript
private ensureEmbeddingEndpoint(): string {
  if (!this.embeddingEndpointName) {
    throw new ConfigurationError(
      'Embedding endpoint not configured. Set DATABRICKS_SERVING_EMBEDDING_ENDPOINT.',
    );
  }
  return this.embeddingEndpointName;
}
```

### Shutdown Behavior

On SIGTERM/SIGINT: call `this.streamManager.abortAll()` to cancel in-flight streaming requests (matching Genie plugin pattern). The AbortSignal propagates to upstream `fetch()` calls, cancelling TCP connections.

## API Surface

### Programmatic API (exports)

```typescript
// packages/appkit/src/plugins/serving/types.ts

type ChatMessageRole = 'system' | 'user' | 'assistant' | 'tool' | (string & {});

interface ChatMessage {
  role: ChatMessageRole;
  content: string;
}

interface ChatCompletionRequest {
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  stop?: string | string[];
  n?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  seed?: number;
  tools?: unknown[];
  tool_choice?: string | Record<string, unknown>;
  response_format?: { type: string };
  user?: string;
}

interface ChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: ChatMessage;
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

interface ChatCompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: Partial<ChatMessage>;
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

interface EmbeddingRequest {
  input: string | string[];
}

interface EmbeddingResponse {
  object: 'list';
  data: Array<{
    object: 'embedding';
    index: number;
    embedding: number[];
  }>;
  model: string;
  usage: {
    prompt_tokens: number;
    total_tokens: number;
  };
}

interface ServingExports {
  chat(params: ChatCompletionRequest): Promise<ChatCompletionResponse>;
  chatStream(params: ChatCompletionRequest): AsyncGenerator<ChatCompletionChunk, void, undefined>;
  embed(params: EmbeddingRequest): Promise<EmbeddingResponse>;
}
```

#### Research Insights

**Type safety improvements (from TypeScript review):**
- Removed `[key: string]: unknown` index signature — it defeats type safety. Known parameters are explicitly typed instead.
- `ChatMessage` extracted as a named interface (reused across request + response types)
- `ChatMessageRole` uses string literal union with `(string & {})` escape hatch for future roles while preserving autocomplete
- `AsyncGenerator<ChatCompletionChunk, void, undefined>` — fully specified generics (no `unknown` defaults)
- All response types fully defined: `ChatCompletionResponse`, `ChatCompletionChunk`, `EmbeddingResponse`
- `ChatCompletionChunk` uses `delta: Partial<ChatMessage>` (not `message`) matching the OpenAI streaming format

### HTTP Routes

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/serving/chat` | OBO | Non-streaming chat completion |
| `POST` | `/api/serving/chat/stream` | OBO | Streaming chat completion (SSE) |
| `POST` | `/api/serving/embeddings` | OBO | Generate embeddings |

### Configuration

```typescript
import { serving } from '@databricks/appkit';

const app = await createApp({
  plugins: [
    serving(), // reads from env vars
  ],
});
```

### Manifest (manifest.json)

```json
{
  "$schema": "https://databricks.github.io/appkit/schemas/plugin-manifest.schema.json",
  "name": "serving",
  "displayName": "Model Serving Plugin",
  "description": "Chat completions and embeddings via Databricks Model Serving endpoints",
  "resources": {
    "required": [
      {
        "type": "serving_endpoint",
        "alias": "Serving Endpoint",
        "resourceKey": "serving-endpoint",
        "description": "Databricks serving endpoint for chat/LLM completions",
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
        "alias": "Embedding Endpoint",
        "resourceKey": "serving-embedding-endpoint",
        "description": "Databricks serving endpoint for embeddings (for RAG use cases)",
        "permission": "CAN_QUERY",
        "fields": {
          "name": {
            "env": "DATABRICKS_SERVING_EMBEDDING_ENDPOINT",
            "description": "Name of the embedding serving endpoint"
          }
        }
      }
    ]
  }
}
```

#### Research Insights

**Resource validation (from architecture + simplicity reviews):** One required resource (chat endpoint) + one optional (embedding endpoint). This matches the standard manifest pattern — required resource is always present, optional is prompted with "Configure X? (optional)" by the CLI. No `getResourceRequirements()` needed. `setup()` only validates the optional embedding endpoint name format if configured.

## Acceptance Criteria

- [ ] Plugin class `ServingPlugin` extends `Plugin<IServingConfig>` with `static manifest = manifest as PluginManifest<"serving">`
- [ ] `manifest.json` with `$schema` field, one required `serving_endpoint` (chat) and one optional (embedding)
- [ ] `setup()` validates endpoint name format with regex
- [ ] **Chat (non-streaming):** `POST /api/serving/chat` proxies to Databricks, returns `ChatCompletionResponse`
- [ ] **Chat (streaming):** `POST /api/serving/chat/stream` returns SSE stream of `ChatCompletionChunk` via `executeStream()`
- [ ] **Embeddings:** `POST /api/serving/embeddings` proxies to Databricks, returns `EmbeddingResponse`
- [ ] Programmatic API: `exports()` returns `{ chat, chatStream, embed }`
- [ ] OBO: HTTP routes use `asUser(req)`, programmatic API supports `.asUser(req)`
- [ ] Embedding endpoint validation with clear error message when `embed()` called without `DATABRICKS_SERVING_EMBEDDING_ENDPOINT`
- [ ] Interceptor defaults: chat (120s timeout, no retry, no cache), embeddings (30s timeout, 3 retries, 1hr cache with LRU)
- [ ] Generic error passthrough: forward upstream status code, sanitize error messages (truncate to 200 chars, generic message for 5xx)
- [ ] Stream cancellation: `AbortSignal.any()` combining client disconnect + timeout, propagated to upstream `fetch()`
- [ ] SSE parser: buffer across TCP chunks, split on `\n\n`, handle `[DONE]` sentinel, skip malformed JSON
- [ ] Request validation: parameter allowlist, message array bounds, input bounds, body size limit
- [ ] URL construction via `new URL()` with `encodeURIComponent()`
- [ ] Exported via `toPlugin(ServingPlugin)` as `serving`, registered in `plugins/index.ts` and `src/index.ts`
- [ ] Unit tests covering: route registration, chat request/response, streaming, embeddings, OBO, endpoint validation errors, error passthrough, parameter filtering
- [ ] Dev-playground: "Paste & Ask" RAG page demonstrating `embed()` + `chatStream()` composition
- [ ] Template: conditional `ServingPage.tsx` with simple streaming chat (included when serving plugin is selected)

## Implementation Phases

### Phase 1: Plugin Scaffold + Non-streaming Chat + Embeddings

1. Create `packages/appkit/src/plugins/serving/` directory structure
2. Write `manifest.json` with `$schema` and two optional `serving_endpoint` resources
3. Write `types.ts` with `IServingConfig extends BasePluginConfig` + all OpenAI-compatible request/response types
4. Write `defaults.ts` with `SERVING_CHAT_DEFAULTS`, `SERVING_STREAM_DEFAULTS`, `SERVING_EMBED_DEFAULTS`
5. Write `serving.ts`:
   - `ServingPlugin` class extending `Plugin<IServingConfig>`
   - `static manifest = manifest as PluginManifest<"serving">`
   - `setup()` — read endpoint names from env vars, validate name format with regex
   - Private `_invoke()` helper — raw `fetch()` with `new URL()`, SDK auth, AbortSignal
   - `_handleChat()` — validate messages (allowlist, bounds), call `_invoke()`, return response
   - `_handleEmbed()` — validate input (bounds), call `_invoke()` with cache interceptor, return response
   - `injectRoutes()` — register `POST /chat`, `POST /embeddings` with OBO
   - `exports()` — return `{ chat, embed }` methods
   - `/** @internal */ export const serving = toPlugin(ServingPlugin)`
6. Write `index.ts` — `export * from "./serving"; export * from "./types";`
7. Register in `plugins/index.ts` and `packages/appkit/src/index.ts`
8. Add unit tests for non-streaming chat + embeddings

### Phase 2: Streaming Chat + Polish

1. Add `_parseSSEStream()` — AsyncGenerator that parses upstream SSE response body, buffers across TCP chunks, yields `ChatCompletionChunk`
2. Add `_handleChatStream()` — validate messages, call upstream with `stream: true`, use `executeStream()` with the SSE parser generator
3. Add `POST /api/serving/chat/stream` route using `executeStream()`
4. Wire AbortSignal chain: `AbortSignal.any([clientDisconnect, timeout])` → upstream fetch + generator
5. Add `chatStream()` to `exports()`
6. Add unit tests for streaming (mock SSE response, verify chunk parsing, test abort propagation)
7. Verify end-to-end with dev-playground (optional)

#### Research Insights

**Phase simplification (from simplicity review):** Collapsed from 4 phases to 2. Non-streaming chat and embeddings share the same `_invoke()` fetch pattern and differ only in request body and response type — no reason to separate them. Streaming is the genuinely different piece (SSE parsing, `executeStream()`, abort handling).

### Phase 3: Demo & Template Integration

#### Dev-Playground: "Paste & Ask" RAG Page

A new route (`/model-serving.route.tsx`) demonstrating both `chatStream()` and `embed()` composing into a RAG workflow:

1. **UI:** Split layout — left panel for pasting text chunks, right panel for chat
2. **Ingest flow:** User pastes text → app calls `POST /api/serving/embeddings` → vectors stored in-memory on server (per-session `Map<sessionId, { chunks: string[], embeddings: number[][] }>`)
3. **Query flow:** User asks a question → embed the query → cosine similarity against stored vectors → top-K chunks as context → `POST /api/serving/chat/stream` with system prompt containing context → stream response with source references
4. **Server-side:** Add a custom route (or a thin wrapper in the plugin demo) for the RAG orchestration:
   - `POST /api/rag/ingest` — accepts text, chunks it, embeds chunks, stores per session
   - `POST /api/rag/query` — embeds question, retrieves context, streams chat response
   - In-memory `Map` for vector storage, cosine similarity helper (~15 LOC)
5. **Frontend:** React page with:
   - Text area + "Add to knowledge base" button
   - Chat input + streaming message display
   - "Sources" accordion under each answer showing which chunks were used

**Why not just a chat page:** Genie already demonstrates chat with streaming. This RAG demo shows plugin composition (`embed()` + `chatStream()`) and a real use case that's unique to model serving.

#### Template: Simple Streaming Chat Page

Add a conditional `ServingPage.tsx` to the template (included when serving plugin is selected):

1. **UI:** Simple chat interface with message history and streaming responses
2. **Backend:** Single route calling `chatStream()` with conversation history from the frontend
3. **No RAG, no embeddings** — template stays minimal. A code comment points to the dev-playground RAG pattern for extension
4. **Template files:**
   - `template/client/src/pages/ServingPage.tsx` — chat UI with streaming
   - Conditional imports in `template/client/src/App.tsx`
   - Plugin wiring in `template/server/server.ts`

#### CLI/Template Integration

No CLI code changes needed — the existing `serving_endpoint` resource support handles everything:

1. Add `serving` plugin entry to template's `appkit.plugins.json` with the manifest resources
2. Add conditional `ServingPage.tsx` to template client
3. Add conditional plugin import/wiring in template `server.ts`
4. Add `DATABRICKS_SERVING_ENDPOINT` to `.env.tmpl` / `.env.example.tmpl`
5. The CLI's `PromptForServingEndpoint`, `ListServingEndpoints`, prefetching, and bundle generation work automatically with the manifest

#### Future Enhancement: Lakebase pgvector

Document (but don't implement) swapping the in-memory vector store for Lakebase with pgvector:
- `VectorStore` interface abstraction for drop-in replacement
- pgvector table schema: `doc_chunks(id, session_id, content, embedding vector(1024))`
- Similarity search: `ORDER BY embedding <-> $query LIMIT $k`

## System-Wide Impact

- **New SSE parser utility:** The upstream SSE parser (`_parseSSEStream`) is specific to this plugin but could be extracted to `packages/appkit/src/stream/` if other plugins need proxy capabilities in the future.
- **No existing code modified:** This is purely additive — new plugin directory, new exports. No changes to base classes, stream infrastructure, or other plugins.
- **Type generation:** The `appKitTypesPlugin` Vite plugin will auto-generate types for `appkit.serving.chat()` etc. at build time.

## Known Limitations (v1)

- Single endpoint per type (chat + embeddings). Multi-endpoint support (e.g., "fast" vs "quality" models) deferred.
- ChatAgent and ResponsesAgent endpoint types not supported (natural future extension — see `app-templates/e2e-chatbot-app` for reference patterns).
- No config-level default model parameters (e.g., default temperature). Callers pass all params per request.
- No model metadata endpoint (e.g., "which model is configured").
- No plugin-level rate limiting (relies on Databricks 429 responses).
- No backpressure handling on downstream SSE writes (existing AppKit StreamManager gap, not blocking for v1).

## Success Metrics

- Plugin works end-to-end with a real Databricks serving endpoint
- Streaming chat completions render in real-time on the frontend
- Embedding results are cached correctly (same input returns cached result)
- OBO auth passes the user's token to Databricks
- No connection starvation under 50+ concurrent requests (with configured connection pool)

## Dependencies & Risks

- **`@databricks/sdk-experimental` v0.16.0** — confirmed: SDK does NOT support streaming for serving endpoints. `servingEndpoints.query()` returns `Promise<QueryEndpointResponse>` only. SDK also lacks `ChatCompletionChunk` type. Raw `fetch()` is required.
- **Serving endpoint availability** — testing requires a live Databricks serving endpoint. Unit tests mock the fetch calls.
- **Node.js version** — `AbortSignal.any()` requires Node.js 20+. Check the repo's minimum Node.js version.

## Security Checklist

From security review — implement during corresponding phase:

- [ ] Endpoint names validated against `/^[a-zA-Z0-9_-]{1,128}$/` at setup (required + optional if configured)
- [ ] URL constructed using `new URL()` + `encodeURIComponent()` to prevent path traversal
- [ ] Request body fields filtered through parameter allowlist (no open `[key: string]: unknown`)
- [ ] Error responses sanitized: truncate to 200 chars, generic message for 5xx
- [ ] Message array: max 256 messages, content max 128K chars, role validated
- [ ] Embedding input: max 100 items if array, each max 32K chars
- [ ] Express body-parser limit set to 1MB for serving routes
- [ ] Cache key uses SHA-256 hash, includes executor key for OBO isolation
- [ ] AbortSignal propagated to upstream fetch on client disconnect

## Sources & References

### Origin

- **Brainstorm document:** [docs/brainstorms/2026-03-23-model-serving-plugin-brainstorm.md](../brainstorms/2026-03-23-model-serving-plugin-brainstorm.md) — Key decisions carried forward: thin proxy approach, two optional endpoints, OpenAI-compatible passthrough, streaming via executeStream()

### Internal References

- Genie plugin (streaming pattern): `packages/appkit/src/plugins/genie/genie.ts`
- Files plugin (optional resources pattern): `packages/appkit/src/plugins/files/plugin.ts`
- Files connector (raw fetch with SDK auth): `packages/appkit/src/connectors/files/client.ts:262-289`
- Plugin base class: `packages/appkit/src/plugin/plugin.ts`
- StreamManager: `packages/appkit/src/stream/stream-manager.ts`
- SSEWriter: `packages/appkit/src/stream/sse-writer.ts`
- Test helpers: `tools/test-helpers.ts`
- Resource types: `packages/appkit/src/registry/types.generated.ts`

### External References

- [Databricks Model Serving docs](https://docs.databricks.com/aws/en/machine-learning/model-serving/create-manage-serving-endpoints)
- [Foundation model REST API reference](https://docs.databricks.com/aws/en/machine-learning/foundation-model-apis/api-reference)
- [OpenAI Chat Completions API reference](https://platform.openai.com/docs/api-reference/chat)
- [OpenAI Streaming Responses Guide](https://developers.openai.com/api/docs/guides/streaming-responses)
- [Node.js Backpressuring in Streams](https://nodejs.org/en/learn/modules/backpressuring-in-streams)
