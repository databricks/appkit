{{if .plugins.serving -}}
import { useServingInvoke } from '@databricks/appkit-ui/react';
// For streaming endpoints (e.g. chat models), use useServingStream instead:
// import { useServingStream } from '@databricks/appkit-ui/react';
import { useEffect, useMemo, useRef, useState } from 'react';

export function ServingPage() {
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<
    Array<{ role: 'user' | 'assistant'; content: string }>
  >([]);

  const body = useMemo(
    () => ({
      messages: [...messages, { role: 'user' as const, content: input }],
    }),
    [messages, input],
  );

  const { invoke, data, loading, error } = useServingInvoke(body);
  // For streaming endpoints (e.g. chat models), use useServingStream:
  // const { stream, chunks, streaming, error, reset } = useServingStream(body);
  // Then accumulate chunks: chunks.map(c => c?.choices?.[0]?.delta?.content ?? '').join('')

  // Persist assistant response to message history when response arrives
  const prevLoadingRef = useRef(false);
  useEffect(() => {
    if (prevLoadingRef.current && !loading && data) {
      const content =
        (data as Record<string, unknown>)?.choices != null
          ? String(
              ((data as any).choices as any[])?.[0]?.message?.content ?? '',
            )
          : JSON.stringify(data);
      setMessages((prev) => [...prev, { role: 'assistant', content }]);
    }
    prevLoadingRef.current = loading;
  }, [loading, data]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim() || loading) return;

    const userMessage = { role: 'user' as const, content: input.trim() };
    setMessages((prev) => [...prev, userMessage]);
    setInput('');
    setTimeout(() => invoke(), 0);
  }

  return (
    <div className="space-y-6 w-full max-w-4xl mx-auto">
      <div>
        <h2 className="text-2xl font-bold text-foreground">Model Serving</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Chat with a Databricks Model Serving endpoint.
        </p>
      </div>

      <div className="border rounded-lg flex flex-col h-[600px]">
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {messages.map((msg, i) => (
            <div
              key={`msg-${i}-${msg.role}`}
              className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className={`max-w-[80%] rounded-lg px-4 py-2 ${
                  msg.role === 'user'
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted'
                }`}
              >
                <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
              </div>
            </div>
          ))}

          {loading && (
            <div className="flex justify-start">
              <div className="max-w-[80%] rounded-lg px-4 py-2 bg-muted">
                <p className="text-sm whitespace-pre-wrap">...</p>
              </div>
            </div>
          )}

          {error && (
            <div className="text-destructive text-sm p-2 bg-destructive/10 rounded">
              Error: {error}
            </div>
          )}
        </div>

        <form onSubmit={handleSubmit} className="border-t p-4 flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Send a message..."
            className="flex-1 rounded-md border px-3 py-2 text-sm bg-background"
            disabled={loading}
          />
          <button
            type="submit"
            disabled={loading || !input.trim()}
            className="rounded-md bg-primary text-primary-foreground px-4 py-2 text-sm font-medium disabled:opacity-50"
          >
            {loading ? 'Loading...' : 'Send'}
          </button>
        </form>
      </div>
    </div>
  );
}
{{- end}}
