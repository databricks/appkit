import { Button } from "@databricks/appkit-ui/react";
import {
  AgentToolsProvider,
  useAgentTool,
  useAgentToolCatalog,
  useDispatchClientTool,
} from "@databricks/appkit-ui/react/beta";
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useRef, useState } from "react";

/**
 * "UI as a tool" PoC. Demonstrates the round-trip protocol end-to-end:
 *
 *  1. The page wraps its UI in `<AgentToolsProvider>` and registers three
 *     counter tools (`counter.read`, `counter.set`, `counter.increment`)
 *     with `useAgentTool`.
 *  2. The chat hook below snapshots the live catalog with
 *     `useAgentToolCatalog` and includes it in every `POST /chat` body
 *     under `uiTools`.
 *  3. When the agent invokes one of those tools, the server emits an
 *     `appkit.client_tool_call` SSE event. The chat hook dispatches it
 *     against the registry (via `useDispatchClientTool`) and POSTs the
 *     outcome to `/chat/client-tool-result`.
 *  4. The agent loop resumes with the result the browser produced. The
 *     counter visibly updates as the agent works through the user's
 *     request.
 *
 * This is not the final shape of PR 1 — capabilities, tool tiers, and the
 * `ui.getContext()` framework tool are deferred. The minimum viable
 * demonstration is here so we can convince ourselves the protocol round
 * trips reliably before generalising.
 */

export const Route = createFileRoute("/agent-ui-poc")({
  component: AgentUiPocRoute,
});

function AgentUiPocRoute() {
  return (
    <AgentToolsProvider>
      <PageBody />
    </AgentToolsProvider>
  );
}

function PageBody() {
  const [count, setCount] = useState(0);

  // Three tools the agent can call. `read` is non-mutating; `set` and
  // `increment` mutate. Annotations are kept simple for the PoC — none of
  // these are flagged destructive so the approval gate stays out of the
  // way for the round-trip demo.
  useAgentTool({
    name: "counter.read",
    description:
      "Return the current numeric value of the counter shown to the user.",
    parameters: { type: "object", properties: {} },
    annotations: { effect: "read" },
    execute: () => ({ value: count }),
  });

  // Note: `counter.set` / `counter.increment` mutate state, but they are NOT
  // annotated `effect: "update"` for the PoC. The agents plugin requires
  // approval for any write/update/destructive tool, and this minimal demo
  // route does not render an approval card. A productionised version (PR 1)
  // would annotate them honestly and reuse the existing approval-card UI
  // already shipped in `/agent` — the protocol composes by design.
  useAgentTool({
    name: "counter.set",
    description: "Set the counter to a specific integer value.",
    parameters: {
      type: "object",
      properties: {
        value: {
          type: "integer",
          description: "Target value the counter should display.",
        },
      },
      required: ["value"],
    },
    execute: (args: Record<string, unknown>) => {
      const value = Number(args.value);
      if (!Number.isFinite(value) || !Number.isInteger(value)) {
        throw new Error("`value` must be an integer");
      }
      setCount(value);
      return { value };
    },
  });

  useAgentTool({
    name: "counter.increment",
    description: "Increase the counter by 1 and return the new value.",
    parameters: { type: "object", properties: {} },
    execute: () => {
      let next = count;
      // Use the functional setter to coalesce rapid agent calls without
      // dropping intermediate increments. The returned value reads from a
      // fresh closure scope below.
      setCount((prev) => {
        next = prev + 1;
        return next;
      });
      return { value: next };
    },
  });

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-7xl mx-auto px-6 py-12">
        <div className="mb-8">
          <h1 className="text-3xl font-bold mb-2">Agent + UI Tools PoC</h1>
          <p className="text-base text-muted-foreground">
            The agent can read and modify the counter below by calling tools
            registered from this page. Try{" "}
            <em>"set the counter to 7 and then increment it twice"</em>.
          </p>
        </div>

        <div className="flex gap-6">
          <CounterPanel count={count} onReset={() => setCount(0)} />
          <ChatPanel />
        </div>
      </div>
    </div>
  );
}

function CounterPanel({
  count,
  onReset,
}: {
  count: number;
  onReset: () => void;
}) {
  return (
    <div className="w-80 shrink-0 border rounded-lg bg-card p-6 flex flex-col items-center gap-4">
      <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
        Counter
      </h2>
      <div className="text-7xl font-bold tabular-nums">{count}</div>
      <p className="text-xs text-muted-foreground text-center">
        Bound to <code>counter.*</code> tools registered on this page. The agent
        reads and mutates this value over the round-trip protocol.
      </p>
      <Button variant="outline" size="sm" onClick={onReset}>
        Reset to 0
      </Button>
    </div>
  );
}

interface ChatMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
}

interface EventLine {
  id: number;
  label: string;
  detail: string;
}

function ChatPanel() {
  const catalog = useAgentToolCatalog();
  const dispatchClientTool = useDispatchClientTool();

  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [events, setEvents] = useState<EventLine[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [threadId, setThreadId] = useState<string | null>(null);

  const idRef = useRef(0);
  // `nextId` is intentionally a stable callback so it doesn't fragment
  // every memoised consumer's dep list. The ref-backed counter guarantees
  // monotonicity across re-renders.
  const nextId = useCallback(() => ++idRef.current, []);

  const appendEvent = useCallback(
    (label: string, detail: string) => {
      setEvents((prev) => [...prev, { id: nextId(), label, detail }]);
    },
    [nextId],
  );

  const send = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed || isLoading) return;

    setInput("");
    setMessages((prev) => [
      ...prev,
      { id: nextId(), role: "user", content: trimmed },
    ]);
    setIsLoading(true);

    try {
      const res = await fetch("/api/agents/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: trimmed,
          ...(threadId && { threadId }),
          uiTools: catalog,
        }),
      });

      if (!res.ok) {
        const text = await res.text();
        setMessages((prev) => [
          ...prev,
          {
            id: nextId(),
            role: "assistant",
            content: `Server error (${res.status}): ${text}`,
          },
        ]);
        return;
      }

      await consumeStream(res, {
        catalog,
        dispatchClientTool,
        appendEvent,
        setMessages,
        setThreadId,
        nextId,
      });
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          id: nextId(),
          role: "assistant",
          content: `Error: ${
            err instanceof Error ? err.message : "Unknown error"
          }`,
        },
      ]);
    } finally {
      setIsLoading(false);
    }
  }, [
    input,
    isLoading,
    threadId,
    catalog,
    dispatchClientTool,
    appendEvent,
    nextId,
  ]);

  return (
    <div className="flex-1 flex gap-4 h-[600px] min-w-0">
      <div className="flex-1 flex flex-col border rounded-lg bg-card min-w-0">
        <div className="border-b px-4 py-2 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-muted-foreground">Chat</h3>
          <span className="text-xs text-muted-foreground">
            {catalog.length} UI tool(s) registered
          </span>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {messages.length === 0 && (
            <div className="text-center text-muted-foreground py-16">
              <p className="text-sm">
                Send a message — the agent has access to the counter tools.
              </p>
            </div>
          )}
          {messages.map((msg) => (
            <div
              key={msg.id}
              className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap ${
                  msg.role === "user"
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted"
                }`}
              >
                {msg.content}
              </div>
            </div>
          ))}
          {isLoading && messages[messages.length - 1]?.role === "user" && (
            <div className="flex justify-start">
              <div className="bg-muted rounded-lg px-3 py-2 text-sm text-muted-foreground animate-pulse">
                Thinking…
              </div>
            </div>
          )}
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
          className="border-t p-3 flex gap-2"
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Tell the agent what to do…"
            disabled={isLoading}
            className="flex-1 rounded-md border border-input bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          />
          <Button type="submit" disabled={isLoading || !input.trim()}>
            Send
          </Button>
        </form>
      </div>
      <div className="w-72 shrink-0 flex flex-col border rounded-lg bg-card">
        <div className="px-3 py-2 border-b">
          <h3 className="text-sm font-semibold text-muted-foreground">
            Round-trip events
          </h3>
        </div>
        <div className="flex-1 overflow-y-auto p-3 space-y-1 font-mono text-xs">
          {events.length === 0 && (
            <p className="text-muted-foreground/50 text-center py-4">
              Tool round-trips will appear here.
            </p>
          )}
          {events.map((evt) => (
            <div key={evt.id} className="text-muted-foreground">
              <span className="opacity-50 inline-block w-24 text-right mr-2">
                {evt.label}
              </span>
              <span className="opacity-90 break-all">{evt.detail}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

interface ClientToolCallEvent {
  type: "appkit.client_tool_call";
  call_id: string;
  stream_id: string;
  tool_name: string;
  args: unknown;
}

interface ConsumeStreamArgs {
  catalog: ReturnType<typeof useAgentToolCatalog>;
  dispatchClientTool: ReturnType<typeof useDispatchClientTool>;
  appendEvent: (label: string, detail: string) => void;
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  setThreadId: React.Dispatch<React.SetStateAction<string | null>>;
  nextId: () => number;
}

/**
 * Consume the SSE chat stream, accumulate assistant text, and round-trip
 * any `appkit.client_tool_call` events through the registry.
 *
 * Kept outside the component to make the dispatch flow easier to read in
 * isolation. Two notable details:
 *
 * - The `streamId` we POST to `/client-tool-result` comes from the event
 *   itself (`stream_id`), not from the chat request. The server keys
 *   pending gates by stream and rejects mismatches; we don't need to
 *   thread our own request id through.
 *
 * - Tool dispatches are awaited in series. Parallel UI tool calls would
 *   need an explicit `Promise.all`, but the agent loop today only emits
 *   one tool call per step anyway, so serial is correct and simpler.
 */
async function consumeStream(
  response: Response,
  args: ConsumeStreamArgs,
): Promise<void> {
  const { dispatchClientTool, appendEvent, setMessages, setThreadId, nextId } =
    args;

  const reader = response.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();

  let buffer = "";
  let assistantContent = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (!data || data === "[DONE]") continue;
      let evt: { type?: string; [k: string]: unknown };
      try {
        evt = JSON.parse(data);
      } catch {
        continue;
      }
      if (!evt.type) continue;

      if (evt.type === "appkit.metadata") {
        const tid = (evt.data as { threadId?: unknown } | undefined)?.threadId;
        if (typeof tid === "string") setThreadId(tid);
        continue;
      }

      if (evt.type === "response.output_text.delta") {
        const delta = (evt as { delta?: unknown }).delta;
        if (typeof delta !== "string") continue;
        assistantContent += delta;
        const snapshot = assistantContent;
        setMessages((prev) => {
          const updated = [...prev];
          const last = updated[updated.length - 1];
          if (last?.role === "assistant") {
            updated[updated.length - 1] = { ...last, content: snapshot };
          } else {
            updated.push({
              id: nextId(),
              role: "assistant",
              content: snapshot,
            });
          }
          return updated;
        });
        continue;
      }

      if (evt.type === "response.output_item.done") {
        const item = (evt as { item?: { type?: string; name?: string } }).item;
        if (item?.type === "function_call") {
          appendEvent("tool_call", item.name ?? "<unnamed>");
        }
        continue;
      }

      if (evt.type === "appkit.client_tool_call") {
        const call = evt as unknown as ClientToolCallEvent;
        appendEvent(
          "client_tool_call",
          `${call.tool_name}(${JSON.stringify(call.args ?? {})})`,
        );
        // Dispatch + post outcome. Errors here become a structured error
        // sent to the server, which the agent sees as the tool result.
        const outcome = await dispatchClientTool(
          call.tool_name,
          (call.args ?? {}) as Record<string, unknown>,
        );
        appendEvent(
          outcome.kind === "ok" ? "tool_result" : "tool_error",
          outcome.kind === "ok"
            ? JSON.stringify(outcome.result)
            : outcome.error,
        );
        const body =
          outcome.kind === "ok"
            ? {
                streamId: call.stream_id,
                callId: call.call_id,
                result: outcome.result,
              }
            : {
                streamId: call.stream_id,
                callId: call.call_id,
                error: outcome.error,
              };
        try {
          await fetch("/api/agents/client-tool-result", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
        } catch (err) {
          appendEvent(
            "post_failed",
            err instanceof Error ? err.message : "Unknown error",
          );
        }
        continue;
      }

      if (evt.type === "error") {
        appendEvent(
          "error",
          (evt as { error?: string }).error ?? "Unknown error",
        );
      }
    }
  }
}
