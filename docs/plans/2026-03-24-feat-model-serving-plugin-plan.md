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
**Code review on:** 2026-03-25
**Code review agents used:** Architecture strategist, Security sentinel, Performance oracle, Spec flow analyzer, Pattern recognition specialist

### Key Improvements
1. **Type safety hardened** — removed unsafe index signature, added string literal unions for roles, fully specified response types
2. **Security hardened** — parameter allowlist (v1 excludes `tools`, `tool_choice`, `logit_bias`, `user`), endpoint name validation, input size limits, error sanitization, `n` capped at 5, `user` set server-side
3. **Performance grounded** — connection pool in v1 (undici Agent, 100 connections), proper SSE frame parser, AbortSignal chain, embedding cache uses shared global `CacheManager` (default `maxSize: 1000`)
4. **Simplified** — collapsed to 2 implementation phases, dropped separate connector directory, generic error passthrough instead of per-code mapping
5. **SDK confirmed** — `@databricks/sdk-experimental` does NOT support streaming for serving endpoints; raw `fetch()` is required
6. **Streaming clarified** — programmatic `chat()` returns raw `AsyncGenerator` (like Genie's `sendMessage`), HTTP route uses `executeStream(res, ...)`. Non-streaming `chatCollect()` and `POST /chat` call Databricks without `stream: true` directly
7. **Pattern alignment verified** — bare `extends Plugin` (not generic), camelCase defaults, manifest `config` section, index re-exports defaults

### New Considerations Discovered
- AppKit has no upstream SSE parser — need to create one for proxy scenarios
- `SSEWriter.writeEvent()` doesn't handle backpressure (known gap, not blocking for v1)
- Resource model simplified: one required (chat) + one optional (embedding) — aligns with CLI `apps init` flow and Databricks Apps `valueFrom` pattern
- StreamManager uses `crypto.randomUUID()` for connection IDs — SSE reconnection replay is session-isolated
- Node.js 24.13.1 pinned via `.nvmrc` — `AbortSignal.any()` is safe to use
- OBO token expiry mid-stream is a known v1 limitation (no automatic refresh during streaming)

---

## Overview

Add a new `serving` plugin to AppKit that provides authenticated access to Databricks Model Serving endpoints for chat completions (streaming + non-streaming) and embeddings. The plugin acts as a thin proxy — leveraging AppKit's interceptor chain (retry, timeout, telemetry, cache) while preserving the standard OpenAI-compatible API format.

## Problem Statement / Motivation

Currently, apps that need to interact with Databricks Model Serving (e.g., the `e2e-chatbot-app` template) must handle authentication, streaming SSE parsing, retry logic, and error handling manually — often with ~300+ lines of boilerplate. AppKit already provides all of these capabilities through its plugin interceptor chain, but has no serving plugin to leverage them.

## Proposed Solution

A `serving` plugin following the established plugin patterns (Genie for streaming, Files for optional multi-resource config). The plugin is a thin proxy: requests are validated minimally and forwarded to Databricks, responses are passed through in OpenAI-compatible format.

### Design Decisions (from brainstorm)

1. **One required + one optional endpoint** — `DATABRICKS_SERVING_ENDPOINT` (required) is the primary endpoint for all operations (chat, embeddings, or agent). `DATABRICKS_SERVING_ENDPOINT_EMBEDDING` (optional) overrides the endpoint for embeddings when a separate model is needed. `chat()` always uses primary; `embed()` uses override if set, falls back to primary. Aligns with CLI `apps init` flow and Databricks Apps `valueFrom` resource pattern. _(see brainstorm: Key Decision 1)_
2. **OpenAI-compatible passthrough** — no custom request/response types beyond TypeScript typing. _(see brainstorm: Key Decision 2)_
3. **Streaming for programmatic API, both modes for HTTP** — The programmatic `chat()` always streams, returning `AsyncGenerator<ChatCompletionChunk>` via `yield*` from an internal generator (like Genie's `sendMessage` pattern). A convenience `chatCollect()` method calls Databricks without `stream: true` and returns `Promise<ChatCompletionResponse>` for server-side callers that need the full response (e.g., RAG orchestration). The non-streaming HTTP route (`POST /chat`) calls Databricks without `stream: true` directly. The streaming HTTP route (`POST /chat/stream`) uses `executeStream(res, ...)` to proxy the upstream SSE stream through AppKit's StreamManager. _(see brainstorm: Key Decision 3, refined by code review)_
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

**Simplification (from simplicity review):** Dropped the separate `connectors/serving/` directory. The serving connector is a thin `fetch()` wrapper (~30 LOC per method). Inline the fetch logic as private methods in `serving.ts`, or extract a single `_invoke()` helper. If a second plugin needs serving endpoint access (e.g., future agents plugin), extract to `connectors/serving/client.ts` at that point. Note: the architecture review recommended keeping the connector for pattern consistency — this is a conscious trade-off favoring simplicity for a thin proxy.

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
| `chatCollect()` / `POST /chat` (non-streaming) | 30s | `retryOn: [503]`, 2 attempts (cold-start resilience) | disabled |
| `chat()` / `POST /chat/stream` (streaming) | 120s | disabled (stateful connection, non-deterministic) | disabled |
| `embed()` / `POST /embeddings` | 30s | 3 attempts with backoff (idempotent, cheap) | TTL 3600s (shared global CacheManager pool) |

#### Research Insights

**Naming convention (from pattern review + code review):** Existing plugins use two conventions: Files uses SCREAMING_SNAKE_CASE (`FILES_READ_DEFAULTS`), while Genie (`genieStreamDefaults`) and Analytics (`queryDefaults`) use camelCase. Follow the majority convention: `servingChatDefaults`, `servingChatStreamDefaults`, `servingEmbedDefaults`.

**Cache infrastructure (from performance review + code review):** The embedding cache uses AppKit's shared `CacheManager` singleton with global `maxSize` (default 1000). There is no per-plugin `maxEntries` config — `CacheInterceptor` only passes `cacheKey` and `ttl`. Embedding cache entries compete with all other cached data (analytics queries, etc.) in the same pool. This is acceptable for v1; per-plugin cache partitioning would require infrastructure changes. LRU eviction in `InMemoryStorage` is O(n) per eviction — negligible at current `maxSize: 1000`, but would need a doubly-linked list at 10K+. Cache key uses `crypto.createHash('sha256')` on `JSON.stringify(input)` — deterministic, handles array ordering, O(n) in input size.

**Cache key:** `["serving:embed", endpointName, sha256(JSON.stringify(input)), executorKey]` — includes executor key to prevent cross-user cache leaks in OBO mode. Note: `embed({ input: 'hello' })` and `embed({ input: ['hello'] })` produce different cache keys. This is intentional — callers should use a consistent format.

### Streaming Architecture

The plugin has two distinct code paths for chat:

**Non-streaming (`chatCollect()` / `POST /chat`):** Calls `_invoke()` without `stream: true`. Databricks returns a single `ChatCompletionResponse` JSON body. Simple request-response — no SSE parsing needed. This is implemented in Phase 1.

**Internal method separation (from code review — error contract):** Private `_chatCollect(params, signal)` does validation + `_invoke()` and returns `Promise<ChatCompletionResponse>`. The HTTP handler `_handleChat(req, res)` wraps this with `execute()` (for interceptors + error swallowing). The programmatic `exports().chatCollect` delegates to `_chatCollect()` directly — errors propagate to the caller. Same pattern for `_embed(params, signal)`. This matches how Genie's `sendMessage` calls the connector directly while the HTTP handler uses `executeStream()`. **Consequence: interceptors (cache, retry, timeout, telemetry) only apply to HTTP routes, not programmatic API.** Programmatic callers requiring caching/retry for `embed()` should implement their own or use HTTP routes.

**Streaming (`chat()` / `POST /chat/stream`):** The plugin's `_streamChat()` method:
1. Sends `POST /serving-endpoints/{name}/invocations` with `stream: true` to Databricks
2. Consumes the upstream SSE response via `response.body` (ReadableStream)
3. Parses SSE frames using a layered generator approach, yielding `ChatCompletionChunk` objects

The **programmatic API** (`exports().chat`) returns the raw `AsyncGenerator<ChatCompletionChunk>` from `_streamChat()` directly — using `yield*` delegation, NOT `executeStream()`. This matches Genie's `sendMessage` pattern where the programmatic API is a plain async generator.

The **HTTP route** (`POST /chat/stream`) uses `this.executeStream(res, () => this._streamChat(...), streamSettings)` — which wraps the generator for SSE delivery via AppKit's StreamManager (with connection IDs, event ring buffer, heartbeat).

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

**Buffer safety:** Add a max buffer size check (~1MB). If the upstream Databricks endpoint returns a malformed non-SSE response (e.g., a large error page without `\n\n`), the buffer grows without bound. Abort the stream if the buffer exceeds the limit.

**Anti-patterns to avoid:**
- Do NOT assume 1 `read()` = 1 SSE event
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

**`X-Accel-Buffering: no` header (from streaming research):** Add to SSE response headers to prevent nginx/cloud LB buffering. AppKit's `SSEWriter.setupHeaders()` already sets `Content-Encoding: none` but not this header. Ideally add `X-Accel-Buffering: no` to `SSEWriter.setupHeaders()` globally (benefits all streaming plugins, including Genie). If scoped to serving only for v1, file a follow-up issue for the global fix.

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

Consider separate pools for streaming (long-lived) vs. non-streaming (short-lived) to prevent head-of-line blocking — this is a v2 optimization. For v1, include a single undici `Agent` with `connections: 100` (configurable via `IServingConfig.connectionPoolSize`). Default `fetch()` only allows ~10 connections per origin, which saturates with just 10 concurrent streaming users — each streaming request holds a TCP connection for the full LLM response duration (30-120s). The 6-line `Agent` config prevents this at near-zero cost (undici idle connection overhead is ~1KB memory). 100 provides headroom for mixed streaming + non-streaming workloads (at 40 concurrent streaming users, 60 remain for embeddings). Add a `// TODO: separate pools for streaming vs non-streaming` comment for v2.

### Request Validation

Minimal validation with security guardrails:

#### Research Insights

**Parameter allowlist (from security review — CRITICAL):** Replace the `[key: string]: unknown` index signature with an explicit allowlist of known OpenAI parameters. This prevents prototype pollution, internal parameter injection, and payload size abuse:

```typescript
const ALLOWED_CHAT_PARAMS = new Set([
  'messages', 'model', 'temperature', 'max_tokens', 'top_p', 'stop',
  'n', 'presence_penalty', 'frequency_penalty',
  'response_format', 'seed',
]);
```

**v1 allowlist rationale (from code review — security):** The following parameters are intentionally excluded from v1 to reduce attack surface:
- `tools`, `tool_choice` — opaque blobs that could enable indirect SSRF via function definitions. Add in v2 with structural validation (require `type: "function"`, validate `function.name`).
- `logit_bias` — unbounded `Record<string, number>` map, enables payload amplification. Add in v2 with max 300 entries, values in `[-100, 100]`.
- `user` — allows impersonation in Databricks audit logs. Instead, strip from client requests and set server-side to the authenticated user's identity.

**Additional validation:**
- `model`: included as optional allowed parameter — Foundation Model API endpoints accept/require it. Typically unnecessary for dedicated endpoints, but stripping it would break certain endpoint types
- `n`: cap at max 5 to prevent compute cost amplification
- `stop`: cap at 4 entries, each max 256 chars (matches OpenAI spec)
- `response_format.type`: validate against `"text" | "json_object"` only for v1. The `json_schema` type requires an unbounded nested JSON Schema sub-object that could enable payload amplification (deeply nested schemas, huge `enum` arrays). Add in v2 with a max serialized size (~8KB) on the `response_format` object
- `role`: validate at runtime against known set (`system`, `user`, `assistant`, `tool`). The TypeScript `(string & {})` escape hatch is for future roles only — runtime validation must reject unexpected values to prevent prototype pollution if role is used as object key
- Each `messages` array element must be validated as an object with `role` (string) and `content` (string) properties. Reject malformed elements like `null`, numbers, or bare strings with 400

**Input bounds (from security review):**
- `messages`: non-empty array, max 256 messages, each content max 128K chars
- `input` (embeddings): must be present, max 100 items if array, each max 32K chars
- Express body-parser size limit: set to 1MB for serving routes via per-route middleware (`express.json({ limit: '1mb' })`) — not global. Note: 1MB body-parser is the actual enforcer; per-field limits (256 messages x 128K chars) are secondary defense and exceed the body-parser limit in aggregate

**Endpoint name validation (from security review + Databricks docs — defense in depth):**
```typescript
const ENDPOINT_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;
// Databricks docs: "Endpoint names cannot use the databricks- prefix"
const isValidEndpointName = (name: string) =>
  ENDPOINT_NAME_PATTERN.test(name) && !name.startsWith('databricks-');
```
Validate at startup in `setup()`. Even though values come from env vars, this prevents SSRF if the pattern is ever extended. The `databricks-` prefix restriction comes from Databricks platform requirements.

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

**Mid-stream errors:** Emit SSE error event matching StreamManager's `SSEErrorCode` pattern. Categorize: `UPSTREAM_ERROR` for Databricks failures, `TIMEOUT` for signal abort. Apply the same 200-char truncation and 5xx-genericization to mid-stream error event payloads.

**Cold start / endpoint scaling (from code review):** Databricks endpoints scaling from zero may return 503. The generic error passthrough handles this correctly. Frontends should display a "Model is warming up, please retry" message on 503 responses. Document this pattern in the template's error handling. Note: the 30s embedding timeout could fail prematurely during cold starts — the retry interceptor (3 attempts) mitigates this for embeddings but not for chat.

### Per-Method Endpoint Validation

The chat endpoint is always available (required resource). The embedding endpoint falls back to the primary:
```typescript
private resolveEmbeddingEndpoint(): string {
  return this.embeddingEndpointName ?? this.endpointName;
}
```

### Startup Behavior

`setup()` is called by AppKit after construction. If `DATABRICKS_SERVING_ENDPOINT` is unset or fails regex validation, `setup()` throws — hard failure at startup. This is the correct behavior for a "required" resource: no endpoint means nothing works, and failing early prevents confusing runtime errors. Note: no existing plugin (Genie, Files, Analytics) overrides `setup()` — they do initialization in the constructor. Verify the base `Plugin` class invokes `setup()` during initialization; if not, move this logic to the constructor.

### Shutdown Behavior

Implement `shutdown()` (matching Genie/Analytics/Files pattern):
1. Call `this.streamManager.abortAll()` to cancel in-flight streaming requests
2. Close the undici `Agent` via `this.servingAgent.close()` to release connection pool resources and prevent dangling connections blocking process exit

The AbortSignal propagates to upstream `fetch()` calls, cancelling TCP connections.

**SSE reconnection security (from code review):** StreamManager uses `crypto.randomUUID()` for connection IDs (verified in `stream-manager.ts`), making ID guessing infeasible. Ring buffer replay is scoped to the connection ID, providing adequate session isolation for streaming chat data.

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
  /** Optional — typically unnecessary for dedicated endpoints, but required by Foundation Model API endpoints. */
  model?: string;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  /** Max 4 entries, each max 256 chars (matches OpenAI spec). */
  stop?: string | string[];
  /** Capped at max 5 to prevent compute cost amplification. */
  n?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  seed?: number;
  /** v1: only 'text' | 'json_object'. json_schema deferred to v2 (unbounded sub-object risk). */
  response_format?: { type: 'text' | 'json_object' };
  // Excluded from v1 allowlist (security): tools, tool_choice, logit_bias, user
  // - tools/tool_choice: opaque blobs, potential indirect SSRF — add in v2 with structural validation
  // - logit_bias: unbounded map, payload amplification — add in v2 with entry/value bounds
  // - user: set server-side to authenticated identity for audit log integrity
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
  /** Always streams (like Genie's sendMessage). Returns raw AsyncGenerator via yield* delegation. */
  chat(params: ChatCompletionRequest): AsyncGenerator<ChatCompletionChunk, void, undefined>;
  /** Non-streaming convenience method. Calls Databricks without stream: true, returns full response. */
  chatCollect(params: ChatCompletionRequest): Promise<ChatCompletionResponse>;
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
  },
  "config": {
    "schema": {
      "type": "object",
      "properties": {
        "timeout": {
          "type": "number",
          "description": "Default timeout in milliseconds"
        },
        "connectionPoolSize": {
          "type": "number",
          "description": "Max connections to Databricks serving endpoints (default: 50)"
        }
      }
    }
  }
}
```

#### Research Insights

**Config section (from code review):** All existing manifests (Genie, Analytics, Files) include a `"config"` section with a JSON schema. The serving manifest must include one too.

**Resource validation (from architecture + simplicity reviews):** One required resource (primary endpoint) + one optional (embedding override). This matches the standard manifest pattern — required resource is always present, optional is prompted with "Configure Separate Embedding Endpoint? (optional)" by the CLI. No `getResourceRequirements()` needed. `embed()` falls back to the primary endpoint when the override is not configured.

## Acceptance Criteria

- [ ] Plugin class `ServingPlugin extends Plugin` with `protected declare config: IServingConfig` and `static manifest = manifest as PluginManifest<"serving">`
- [ ] `manifest.json` with `$schema` field, `config` section, one required `serving_endpoint` (chat) and one optional (embedding)
- [ ] `setup()` validates endpoint name format with regex (throws on missing/invalid required endpoint), initializes undici `Agent` connection pool
- [ ] `shutdown()` calls `streamManager.abortAll()` and closes undici `Agent`
- [ ] **Chat (non-streaming):** `POST /api/serving/chat` calls Databricks without `stream: true`, returns `ChatCompletionResponse`
- [ ] **Chat (streaming):** `POST /api/serving/chat/stream` returns SSE stream of `ChatCompletionChunk` via `this.executeStream(res, ...)`
- [ ] **Embeddings:** `POST /api/serving/embeddings` proxies to Databricks, returns `EmbeddingResponse`
- [ ] Programmatic API: `exports()` returns `{ chat, chatCollect, embed }` — `chat()` returns raw `AsyncGenerator` (like Genie's `sendMessage`), `chatCollect()` returns `Promise<ChatCompletionResponse>`. Programmatic methods call internal methods directly (errors propagate), HTTP handlers use `execute()`/`executeStream()` (interceptors apply)
- [ ] OBO: HTTP routes use `asUser(req)`, programmatic API supports `.asUser(req)`
- [ ] `embed()` uses `DATABRICKS_SERVING_ENDPOINT_EMBEDDING` if configured, falls back to `DATABRICKS_SERVING_ENDPOINT`
- [ ] Interceptor defaults: chat non-streaming (30s timeout, retry on 503), chat streaming (120s timeout), embeddings (30s timeout, 3 retries, 1hr cache via shared CacheManager)
- [ ] Connection pool: undici `Agent` with `connections: 100` (configurable via `IServingConfig.connectionPoolSize`)
- [ ] Generic error passthrough: forward upstream status code, sanitize error messages (truncate to 200 chars, generic message for 5xx). Apply same sanitization to mid-stream SSE error events
- [ ] Stream cancellation: `AbortSignal.any()` combining client disconnect + timeout, propagated to upstream `fetch()`
- [ ] SSE parser: extracted to `packages/appkit/src/stream/sse-parser.ts`, buffer across TCP chunks (1MB max buffer), split on `\n\n`, handle `[DONE]` sentinel, skip malformed JSON
- [ ] Request validation: parameter allowlist (v1: excludes `tools`, `tool_choice`, `logit_bias`, `user`; includes `model`), cap `n` at 5, cap `stop` at 4 entries, validate `role` against known set, validate `response_format.type` against `text`/`json_object` (no `json_schema` in v1), validate message element shape, set `user` server-side, body size limit 1MB via per-route middleware
- [ ] URL construction via `new URL()` with `encodeURIComponent()`
- [ ] Exported via `toPlugin(ServingPlugin)` as `serving`, registered in `plugins/index.ts` and `src/index.ts`
- [ ] Unit tests covering: route registration, chat request/response (both streaming and non-streaming), embeddings, OBO, endpoint validation errors, error passthrough, parameter filtering, `chatCollect()`, allowlist enforcement
- [ ] Dev-playground: "Paste & Ask" RAG page demonstrating `embed()` + `chat()` composition
- [ ] Template: conditional `ServingPage.tsx` with simple streaming chat (included when serving plugin is selected)

## Implementation Phases

### Phase 1: Plugin Scaffold + Non-streaming Chat + Embeddings

1. Create `packages/appkit/src/plugins/serving/` directory structure
2. Write `manifest.json` with `$schema`, `config` section, one required and one optional `serving_endpoint` resource
3. Write `types.ts` with `IServingConfig extends BasePluginConfig` + all OpenAI-compatible request/response types (v1 allowlist: excludes `tools`, `tool_choice`, `logit_bias`, `user`)
4. Write `defaults.ts` with `servingChatDefaults`, `servingChatStreamDefaults`, `servingEmbedDefaults` (camelCase, matching Genie/Analytics convention)
5. Write `serving.ts`:
   - `ServingPlugin` class extending `Plugin` (bare, no generic) with `protected declare config: IServingConfig`
   - `static manifest = manifest as PluginManifest<"serving">`
   - `setup()` — read endpoint names from env vars, validate name format with regex (throw on missing/invalid `DATABRICKS_SERVING_ENDPOINT`), initialize undici `Agent` with `connections: 100` (configurable via `config.connectionPoolSize`)
   - `shutdown()` — call `this.streamManager.abortAll()` + `this.servingAgent.close()`
   - Private `_invoke()` helper — raw `fetch()` with `new URL()`, SDK auth, AbortSignal, undici dispatcher
   - Private `_chatCollect(params, signal)` — validate messages (allowlist, bounds, cap `n` at 5, cap `stop` at 4 entries, validate `role` against known set, set `user` server-side), call `_invoke()` without `stream: true`, return `ChatCompletionResponse`. Errors propagate (not swallowed)
   - Private `_embed(params, signal)` — validate input (bounds), call `_invoke()`, return response. Errors propagate
   - HTTP handler `_handleChat(req, res)` — wraps `_chatCollect()` via `this.execute()` for interceptors + error safety
   - HTTP handler `_handleEmbed(req, res)` — wraps `_embed()` via `this.execute()` for interceptors (cache, retry) + error safety
   - `injectRoutes()` — register `POST /chat`, `POST /embeddings` with OBO, per-route `express.json({ limit: '1mb' })` middleware
   - `exports()` — return `{ chat, chatCollect, embed }` methods. `chatCollect` delegates to `_chatCollect()` directly (errors propagate to caller, no interceptors). `embed` delegates to `_embed()` directly. `chat` is a placeholder that throws "streaming not yet implemented" until Phase 2
   - `/** @internal */ export const serving = toPlugin(ServingPlugin)`
6. Write `index.ts` — `export * from "./serving"; export * from "./types"; export * from "./defaults";`
7. Register in `plugins/index.ts` and `packages/appkit/src/index.ts`
8. Add unit tests for non-streaming chat + embeddings + allowlist enforcement

### Phase 2: Streaming Chat + Polish

1. Add `parseSSEStream()` as a generic utility in `packages/appkit/src/stream/sse-parser.ts` — AsyncGenerator that parses any upstream SSE response body, buffers across TCP chunks (with 1MB max buffer size), yields parsed JSON objects. Re-export from `packages/appkit/src/stream/index.ts`. This is the natural complement to the existing `sse-writer.ts` in the `stream/` directory and enables isolated unit testing
2. Add `_streamChat()` — internal async generator that calls upstream with `stream: true` and `yield*` delegates to `_parseSSEStream()`
3. Add `_handleChatStream()` — validate messages, use `this.executeStream(res, () => this._streamChat(...), streamSettings)` for HTTP route
4. Wire `exports().chat` to return raw `AsyncGenerator` via `yield*` from `_streamChat()` (like Genie's `sendMessage` — no `executeStream()` for programmatic API)
5. Add `POST /api/serving/chat/stream` route using `executeStream()`
6. Wire AbortSignal chain: `AbortSignal.any([clientDisconnect, timeout])` → upstream fetch + generator
7. Add unit tests for streaming (mock SSE response, verify chunk parsing, test abort propagation)
8. Verify end-to-end with dev-playground (optional)

#### Research Insights

**Phase simplification (from simplicity review):** Collapsed from 4 phases to 2. Non-streaming chat and embeddings share the same `_invoke()` fetch pattern and differ only in request body and response type — no reason to separate them. Streaming is the genuinely different piece (SSE parsing, `executeStream()`, abort handling).

### Phase 3: Demo & Template Integration

#### Dev-Playground: "Paste & Ask" RAG Page

A new route (`/model-serving.route.tsx`) demonstrating both `chat()` and `embed()` composing into a RAG workflow:

1. **UI:** Split layout — left panel for pasting text chunks, right panel for chat
2. **Ingest flow:** User pastes text → app calls `POST /api/serving/embeddings` → vectors stored in-memory on server (per-session `Map<sessionId, { chunks: string[], embeddings: number[][] }>`)
3. **Query flow:** User asks a question → embed the query → cosine similarity against stored vectors → top-K chunks as context → `POST /api/serving/chat/stream` with system prompt containing context → stream response with source references
4. **Server-side:** Add a custom route (or a thin wrapper in the plugin demo) for the RAG orchestration:
   - `POST /api/rag/ingest` — accepts text, chunks it (split on double newlines/paragraphs, max 2,000 chars per chunk, overflow split at nearest sentence boundary), embeds chunks, stores per session
   - `POST /api/rag/query` — embeds question, retrieves context, streams chat response
   - In-memory `Map` for vector storage, cosine similarity helper (~15 LOC)
   - **Session management:** Frontend generates UUID, stores in `sessionStorage`, sends as `x-session-id` header. Server enforces: session TTL 1 hour, max 200 chunks per session, max 1,000 concurrent sessions. Periodic cleanup sweep every 5 minutes evicts expired sessions to prevent OOM on long-running servers
5. **Frontend:** React page with:
   - Text area + "Add to knowledge base" button
   - Chat input + streaming message display
   - "Sources" accordion under each answer showing which chunks were used

**Why not just a chat page:** Genie already demonstrates chat with streaming. This RAG demo shows plugin composition (`embed()` + `chat()`) and a real use case that's unique to model serving.

#### Template: Simple Streaming Chat Page

Add a conditional `ServingPage.tsx` to the template (included when serving plugin is selected):

1. **UI:** Simple chat interface with message history and streaming responses
2. **Backend:** Single route calling `chat()` with conversation history from the frontend
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

- **New SSE parser utility:** `parseSSEStream()` extracted to `packages/appkit/src/stream/sse-parser.ts` in Phase 2 — generic utility (parses any SSE stream into JSON objects), natural complement to existing `sse-writer.ts`.
- **No existing code modified:** This is purely additive — new plugin directory, new exports. No changes to base classes, stream infrastructure, or other plugins.
- **Type generation:** The `appKitTypesPlugin` Vite plugin will auto-generate types for `appkit.serving.chat()` etc. at build time.

## Known Limitations (v1)

- Single endpoint per type (chat + embeddings). Multi-endpoint support (e.g., "fast" vs "quality" models) deferred.
- ChatAgent and ResponsesAgent endpoint types not supported (natural future extension — see `app-templates/e2e-chatbot-app` for reference patterns).
- No config-level default model parameters (e.g., default temperature). Callers pass all params per request.
- No model metadata endpoint (e.g., "which model is configured").
- `json_schema` response format excluded from v1 (unbounded sub-object risk). Only `text` and `json_object` are allowed.
- Programmatic API (`chatCollect()`, `embed()`, `chat()`) does not go through the interceptor chain (matching Genie/Analytics pattern). Caching and retry only apply to HTTP routes.
- Embedding cache shares the global `CacheManager` pool (default `maxSize: 1000`) — no per-plugin capacity guarantee.
- No plugin-level rate limiting (relies on Databricks 429 responses).
- No backpressure handling on downstream SSE writes (existing AppKit StreamManager gap, not blocking for v1).
- No endpoint readiness check — frontends should handle 503 reactively. A `GET /api/serving/status` endpoint could be a v2 addition.
- OBO tokens close to expiry may cause mid-stream failures on long completions. The SSE parser handles unexpected stream termination gracefully (finally block releases the reader). No automatic token refresh during streaming for v1.

## Success Metrics

- Plugin works end-to-end with a real Databricks serving endpoint
- Streaming chat completions render in real-time on the frontend
- Embedding results are cached correctly (same input returns cached result)
- OBO auth passes the user's token to Databricks
- No connection starvation under 50+ concurrent requests (with configured 100-connection pool)

## Dependencies & Risks

- **`@databricks/sdk-experimental` v0.16.0** — confirmed: SDK does NOT support streaming for serving endpoints. `servingEndpoints.query()` returns `Promise<QueryEndpointResponse>` only. SDK also lacks `ChatCompletionChunk` type. Raw `fetch()` is required.
- **Serving endpoint availability** — testing requires a live Databricks serving endpoint. Unit tests mock the fetch calls.
- **Node.js version** — `AbortSignal.any()` requires Node.js 20+. The repo pins Node.js 24.13.1 via `.nvmrc`, so this is safe.

## Security Checklist

From security review + code review — implement during corresponding phase:

- [ ] Endpoint names validated against `/^[a-zA-Z0-9_-]{1,128}$/` and must not start with `databricks-` prefix (platform restriction) at setup
- [ ] URL constructed using `new URL()` + `encodeURIComponent()` to prevent path traversal
- [ ] Request body fields filtered through parameter allowlist (v1 excludes: `tools`, `tool_choice`, `logit_bias`, `user`; includes `model`)
- [ ] `n` parameter capped at max 5
- [ ] `stop` parameter capped at 4 entries, each max 256 chars
- [ ] `role` validated at runtime against known set (`system`, `user`, `assistant`, `tool`)
- [ ] Each message element validated as object with `role` (string) and `content` (string)
- [ ] `user` field stripped from client requests; set server-side to authenticated user identity for audit log integrity
- [ ] `response_format.type` validated against `"text" | "json_object"` only (no `json_schema` in v1)
- [ ] `content` field enforced as string (not array/object) for v1 (text-only, no multimodal)
- [ ] Error responses sanitized: truncate to 200 chars, generic message for 5xx. Same sanitization applied to mid-stream SSE error events
- [ ] Message array: max 256 messages, content max 128K chars
- [ ] Embedding input: max 100 items if array, each max 32K chars
- [ ] Express body-parser limit set to 1MB via per-route middleware for serving routes
- [ ] SSE parser buffer capped at 1MB to prevent OOM from malformed upstream responses
- [ ] Cache key uses SHA-256 hash, includes executor key for OBO isolation
- [ ] AbortSignal propagated to upstream fetch on client disconnect
- [ ] Connection pool configured via undici `Agent` (default 100 connections, prevents connection starvation)

## Sources & References

### Origin

- **Brainstorm document:** [docs/brainstorms/2026-03-23-model-serving-plugin-brainstorm.md](../brainstorms/2026-03-23-model-serving-plugin-brainstorm.md) — Key decisions carried forward: thin proxy approach, one required + one optional endpoint, OpenAI-compatible passthrough, streaming via AsyncGenerator (programmatic) / executeStream (HTTP)

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

- [Databricks Model Serving overview](https://docs.databricks.com/aws/en/machine-learning/model-serving/)
- [Create and manage serving endpoints](https://docs.databricks.com/aws/en/machine-learning/model-serving/create-manage-serving-endpoints)
- [Model Serving glossary](https://docs.databricks.com/aws/en/machine-learning/model-serving/glossary)
- [Query chat models](https://docs.databricks.com/aws/en/machine-learning/model-serving/query-chat-models)
- [Databricks Apps: Model Serving integration](https://docs.databricks.com/aws/en/dev-tools/databricks-apps/model-serving)
- [OpenAI Chat Completions API reference](https://platform.openai.com/docs/api-reference/chat)
- [OpenAI Streaming Responses Guide](https://developers.openai.com/api/docs/guides/streaming-responses)
- [Node.js Backpressuring in Streams](https://nodejs.org/en/learn/modules/backpressuring-in-streams)
