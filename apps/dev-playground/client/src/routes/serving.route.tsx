import { useServingStream } from "@databricks/appkit-ui/react";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";

export const Route = createFileRoute("/serving")({
  component: ServingRoute,
});

function ServingRoute() {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<
    Array<{ role: "user" | "assistant"; content: string }>
  >([]);

  const body = useMemo(
    () => ({
      messages: [...messages, { role: "user" as const, content: input }],
    }),
    [messages, input],
  );

  const { stream, chunks, streaming, error, reset } = useServingStream(body);

  const assistantContent = chunks
    .map((chunk) => chunk?.choices?.[0]?.delta?.content ?? "")
    .join("");

  // Persist assistant response to message history when streaming completes
  const prevStreamingRef = useRef(false);
  useEffect(() => {
    if (prevStreamingRef.current && !streaming && assistantContent) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: assistantContent },
      ]);
      reset();
    }
    prevStreamingRef.current = streaming;
  }, [streaming, assistantContent, reset]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim() || streaming) return;

    const userMessage = { role: "user" as const, content: input.trim() };
    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    reset();
    // Trigger stream after state update
    setTimeout(() => stream(), 0);
  }

  return (
    <div className="min-h-screen bg-background">
      <main className="max-w-4xl mx-auto px-6 py-12">
        <div className="flex flex-col gap-6">
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-foreground">
              Model Serving
            </h1>
            <p className="text-muted-foreground mt-2">
              Chat with a Databricks Model Serving endpoint. Set{" "}
              <code className="text-sm bg-muted px-1 rounded">
                DATABRICKS_SERVING_ENDPOINT
              </code>{" "}
              to enable.
            </p>
          </div>

          <div className="border rounded-lg flex flex-col h-[600px]">
            {/* Messages area */}
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {messages.map((msg, i) => (
                <div
                  key={`msg-${i}-${msg.role}`}
                  className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
                >
                  <div
                    className={`max-w-[80%] rounded-lg px-4 py-2 ${
                      msg.role === "user"
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted"
                    }`}
                  >
                    <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
                  </div>
                </div>
              ))}

              {/* Streaming response */}
              {(streaming || assistantContent) && (
                <div className="flex justify-start">
                  <div className="max-w-[80%] rounded-lg px-4 py-2 bg-muted">
                    <p className="text-sm whitespace-pre-wrap">
                      {assistantContent || "..."}
                    </p>
                  </div>
                </div>
              )}

              {error && (
                <div className="text-destructive text-sm p-2 bg-destructive/10 rounded">
                  Error: {error}
                </div>
              )}
            </div>

            {/* Input area */}
            <form onSubmit={handleSubmit} className="border-t p-4 flex gap-2">
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Send a message..."
                className="flex-1 rounded-md border px-3 py-2 text-sm bg-background"
                disabled={streaming}
              />
              <button
                type="submit"
                disabled={streaming || !input.trim()}
                className="rounded-md bg-primary text-primary-foreground px-4 py-2 text-sm font-medium disabled:opacity-50"
              >
                {streaming ? "Streaming..." : "Send"}
              </button>
            </form>
          </div>
        </div>
      </main>
    </div>
  );
}
