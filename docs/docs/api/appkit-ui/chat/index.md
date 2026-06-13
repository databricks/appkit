---
sidebar_position: 6
---

# Chat primitives

Headless React building blocks for talking to the AppKit [`agents`](../../plugins/agents.md) plugin from the browser. The primitives are an opinionated wrapper over the [Vercel AI SDK](https://sdk.vercel.ai/) (`@ai-sdk/react`, `ai`) that translates the agents plugin's Responses-API SSE wire format into the SDK's `UIMessageChunk` protocol — so you get streaming text, reasoning, tool calls, approval gates, and thread continuity without writing a server-side adapter.

Everything ships from a single subpath import:

```ts
import {
  Conversation,
  ChatInput,
  ResponsesApiTransport,
  useChat,
  useScrollToBottom,
} from "@databricks/appkit-ui/react/chat";
```

`@ai-sdk/react` and `ai` are **optional peer dependencies**. Install them in your app if you use these primitives:

```bash
pnpm add @ai-sdk/react ai
```

## Quick start

The smallest end-to-end chat against an `agents()`-backed AppKit server:

```tsx
import {
  ChatInput,
  Conversation,
} from "@databricks/appkit-ui/react/chat";

export function Chat() {
  return (
    <Conversation api="/api/agents/chat">
      {({ messages, status, sendMessage, stop, containerRef }) => (
        <div className="flex flex-col h-[600px] border rounded-lg">
          <div ref={containerRef} className="flex-1 overflow-y-auto p-4 space-y-2">
            {messages.map((m) => (
              <div key={m.id} className={m.role === "user" ? "text-right" : "text-left"}>
                {m.parts.map((p, i) =>
                  p.type === "text" ? <p key={i}>{p.text}</p> : null,
                )}
              </div>
            ))}
          </div>
          <ChatInput onSubmit={sendMessage} status={status} stop={stop}>
            {({ value, onChange, submit, isStreaming, canSubmit, handleKeyDown }) => (
              <form onSubmit={submit} className="border-t p-3 flex gap-2">
                <input
                  value={value}
                  onChange={(e) => onChange(e.target.value)}
                  onKeyDown={handleKeyDown}
                  disabled={isStreaming}
                  placeholder="Ask a question…"
                  className="flex-1"
                />
                <button type="submit" disabled={!canSubmit}>Send</button>
              </form>
            )}
          </ChatInput>
        </div>
      )}
    </Conversation>
  );
}
```

That single component:

- Posts to `POST /api/agents/chat` (the agents plugin's default route).
- Streams Responses-API SSE back, translates each event to a `UIMessageChunk` on the fly, and feeds the AI SDK reducer.
- Captures the server-allocated `threadId` from `appkit.metadata` events and replays it on every subsequent request — multi-turn conversations Just Work, no wiring required.
- Auto-sticks the scroll container to the bottom as long as the user hasn't scrolled up.

## How it fits together

```
┌──────────────────────────────────────────────────────────┐
│  <Conversation>                                          │
│   ├─ useChat()             ── stable id + threadId ref   │
│   │   └─ ResponsesApiTransport                           │
│   │        ├─ prepareSendMessagesRequest                 │
│   │        │   → { message, threadId?, ...extras }       │
│   │        └─ processResponseStream                      │
│   │            SSE bytes → text → events → UIChunks      │
│   └─ useScrollToBottom()   ── containerRef + auto-stick  │
│                                                          │
│  <ChatInput>                                             │
│   value / submit / canSubmit / handleKeyDown / stop      │
└──────────────────────────────────────────────────────────┘
```

The `Conversation` component is a thin render-prop convenience over `useChat` + `useScrollToBottom`. Reach for the underlying hooks when you need a non-standard layout (split panes, virtualized lists, etc).

## `useChat`

A minimal wrapper around the AI SDK's `useChat` that wires up `ResponsesApiTransport` and stabilizes the chat `id` and `threadId` across re-renders.

```ts
const chat = useChat<AgentUIMessage>({
  api: "/api/agents/chat",
  onData: (part) => { /* react to data-* parts */ },
  onError: (err) => console.error(err),
});
```

### Options

| Option         | Type                                    | Required | Description |
|----------------|-----------------------------------------|----------|-------------|
| `api`          | `string`                                | ✓        | Chat endpoint URL (typically `/api/agents/chat`). |
| `id`           | `string`                                |          | Stable chat id. Defaults to a fresh UUID per mount. |
| `messages`     | `TMessage[]`                            |          | Initial messages (e.g. when hydrating from history). |
| `headers`      | fetch headers / accessor                |          | Extra request headers forwarded to the transport. |
| `onData`       | `(part) => void`                        |          | Fires for every `data-*` chunk. Use this to react to AppKit-specific data parts like `data-approval-pending`. |
| `onStreamPart` | `(chunk: UIMessageChunk) => void`       |          | Fires synchronously for every translated chunk before the reducer sees it. Ideal for debug panels and stream logs — unaffected by render throttling. |
| `onError`      | `(error: Error) => void`                |          | Network, transport, or server-side stream errors. |

### Returns

The full [`UseChatHelpers`](https://sdk.vercel.ai/docs/reference/ai-sdk-ui/use-chat) surface (`messages`, `status`, `error`, `sendMessage`, `stop`, …) plus a stable `id`.

### Thread continuity

The first SSE event of a new conversation carries an `appkit.metadata` payload with the server-allocated `threadId`. The hook stashes it in a ref, then `ResponsesApiTransport` echoes it on subsequent requests — even if the transport is re-created mid-session (e.g. because `headers` is passed as an inline object literal). You don't need to manage thread ids yourself.

## `useScrollToBottom`

Tracks whether a scroll container is at the bottom and exposes an imperative `scrollToBottom`. When `trigger` changes and the user was already at the bottom, the container auto-sticks — preserving the typical chat "follow latest" behavior without overriding manual scroll-up.

```ts
const { containerRef, isAtBottom, scrollToBottom } =
  useScrollToBottom<HTMLDivElement>({ trigger: messages });
```

| Option      | Type      | Default | Description |
|-------------|-----------|---------|-------------|
| `threshold` | `number`  | `50`    | Pixels from the bottom that still count as "at bottom". |
| `trigger`   | `unknown` | —       | Reactive value (usually `messages`) that triggers an auto-stick when the user is at the bottom. |

`scrollToBottom(behavior)` defaults to `"smooth"`. The auto-stick path uses `"instant"` to avoid piling up smooth-scroll animations under throttled streaming re-renders.

## `<Conversation>`

Render-prop component that combines `useChat` and `useScrollToBottom` for the common case. Accepts every `useChat` option as a top-level prop and exposes both hooks' return values to its `children` callback.

```tsx
<Conversation<AgentUIMessage>
  api="/api/agents/chat"
  onData={(part) => {/* … */}}
>
  {({ messages, status, sendMessage, stop, containerRef, isAtBottom, scrollToBottom }) => (
    /* … */
  )}
</Conversation>
```

If you need to drive the chat from outside the render tree (e.g. an external "Send" button), drop down to `useChat` directly.

## `<ChatInput>`

Render-prop component that owns the input string, debounces submit, handles `Enter`/`Shift+Enter`/IME composition, and forwards an `isStreaming` flag for stop-button toggles.

```tsx
<ChatInput<AgentUIMessage> onSubmit={sendMessage} status={status} stop={stop}>
  {({ value, onChange, submit, isStreaming, stop, canSubmit, handleKeyDown }) => (
    <form onSubmit={submit}>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        disabled={isStreaming}
      />
      {isStreaming
        ? <button type="button" onClick={stop}>Stop</button>
        : <button type="submit" disabled={!canSubmit}>Send</button>}
    </form>
  )}
</ChatInput>
```

| Prop       | Type                                      | Description |
|------------|-------------------------------------------|-------------|
| `onSubmit` | `UseChatHelpers<TMessage>["sendMessage"]` | Pass `sendMessage` straight through from `useChat` / `Conversation`. |
| `status`   | `ChatStatus`                              | Pass `status` from the chat helpers — drives `isStreaming`. |
| `stop`     | `() => void`                              | Pass `stop` from the chat helpers — exposed back to the render prop for stop buttons. |

The render prop returns a `submit` callback you can wire to either a form `onSubmit` or a button `onClick`. `Enter` submits (unless `Shift` is held or an IME is composing); the input clears on successful submit.

## Typed messages

Pass a `UIMessage` subtype to type `messages[].parts`, `onData`, and `sendMessage` end-to-end:

```ts
import type { UIMessage } from "ai";

type MyMessage = UIMessage<unknown, {
  "approval-pending": { approvalId: string; toolName: string };
}>;

const chat = useChat<MyMessage>({ api: "/api/agents/chat" });
```

The data-parts map must be a `type` (not `interface`) to satisfy the SDK's `Record<string, unknown>` constraint.

## Approval gates

When the agents plugin emits an `appkit.approval_pending` SSE event (a destructive tool is paused on the server-side approval gate), the transport surfaces it as a `data-approval-pending` chunk. Subscribe via `onData`:

```tsx
<Conversation
  api="/api/agents/chat"
  onData={(part) => {
    if (part.type === "data-approval-pending") {
      const { approvalId, streamId, toolName, args } = part.data;
      // Render an approval card; POST the decision back to the plugin:
      // fetch("/api/agents/approve", {
      //   method: "POST",
      //   body: JSON.stringify({ streamId, approvalId, decision: "approve" }),
      // });
    }
  }}
>
  {/* … */}
</Conversation>
```

The chunk `id` is the `approvalId`, so duplicate events (re-renders, reconnects) collapse cleanly.

## `ResponsesApiTransport`

The `Conversation` / `useChat` flow is enough for almost every consumer. Drop down to the transport directly if you're composing it with a different React hook surface (e.g. plain `@ai-sdk/react`'s `useChat`) or you need to extend `prepareSendMessagesRequest` to carry attachments, agent ids, or other custom body fields.

```ts
import { ResponsesApiTransport } from "@databricks/appkit-ui/react/chat";
import { useChat } from "@ai-sdk/react";

const threadIdRef = useRef<string | undefined>(undefined);

const transport = useMemo(
  () =>
    new ResponsesApiTransport({
      api: "/api/agents/chat",
      getThreadId: () => threadIdRef.current,
      onThreadId: (tid) => { threadIdRef.current = tid; },
    }),
  [],
);

const chat = useChat({ transport });
```

### Constructor options

Extends `HttpChatTransportInitOptions` (everything except `prepareSendMessagesRequest`, which is owned by the transport) with:

| Option         | Type                                | Description |
|----------------|-------------------------------------|-------------|
| `getThreadId`  | `() => string \| undefined`         | Read the persisted server thread id. Held outside the transport so re-creation doesn't fork the conversation. |
| `onThreadId`   | `(id: string) => void`              | Persist the server thread id snooped from the first `appkit.metadata` event. |
| `onStreamPart` | `(chunk: UIMessageChunk) => void`   | Synchronous tap fired before each chunk reaches the SDK reducer. |

### Wire format

`prepareSendMessagesRequest` builds:

```json
{
  "message": "<latest user-message text>",
  "threadId": "<server-allocated id, omitted on first request>",
  "...extras": "any non-reserved fields you pass via `body`"
}
```

`message` and `threadId` are reserved — values you pass via the `body` option for those keys are ignored. Any other fields you set on `body` are passed through (useful for routing to a specific agent: `body: { agent: "support" }`).

### Event translation

| Server (`ResponseStreamEvent`)                        | Client (`UIMessageChunk`)                            |
|-------------------------------------------------------|------------------------------------------------------|
| `response.output_item.added` (`type: message`)        | `text-start`                                         |
| `response.output_text.delta`                          | `text-delta`                                         |
| `response.output_item.done` (`type: message`)         | `text-end`                                           |
| `response.output_item.added` (`function_call`)        | `tool-input-available`                               |
| `response.output_item.added` (`function_call_output`) | `tool-output-available`                              |
| `appkit.thinking`                                     | `reasoning-start` (lazy) + `reasoning-delta`         |
| `appkit.metadata`                                     | `message-metadata` (and captures `threadId`)         |
| `appkit.approval_pending`                             | `data-approval-pending`                              |
| `error` / `response.failed`                           | `error` + `finish`                                   |
| `response.completed`                                  | `finish`                                             |

A defensive `finish` is emitted in the transform's `flush` callback so the SDK leaves the streaming state even if the server's terminal event is lost (disconnect, timeout).

## Limitations

- **Text-only user messages.** The agents plugin's `chatRequestSchema` accepts `message: string` only. The transport `console.warn`s and drops non-text parts (images, files) from the latest user message. Subclass `ResponsesApiTransport` and override `prepareSendMessagesRequest` to carry attachments via a parallel field, or use a different server endpoint.
- **Beta peer dependencies.** This release is pinned to `@ai-sdk/react@~4.0.0-beta` and `ai@~7.0.0-beta`. The wire-translator may need adjustments when the AI SDK reaches stable.
