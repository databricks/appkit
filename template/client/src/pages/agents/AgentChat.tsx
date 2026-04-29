{{if .plugins.agents -}}
import { useEffect, useRef, useState } from 'react';
import {
  Button,
  Card,
  CardContent,
  Input,
} from '@databricks/appkit-ui/react';

interface Message {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolName?: string;
}

interface AgentInfo {
  agents: string[];
  defaultAgent: string | null;
}

/**
 * Minimal chat surface for the `agents` plugin.
 *
 * - Lists registered agents from `GET /api/agents/info` and lets the user
 *   pick one (markdown `assistant` from `config/agents/assistant/agent.md`
 *   and code-defined `helper` from `server/agents/helper.ts`).
 * - Sends turns to `POST /api/agents/chat` and consumes the SSE stream
 *   the agents plugin emits (Responses-API shape).
 * - Renders streaming assistant text incrementally and surfaces tool
 *   calls as separate inline rows.
 *
 * Replace this with `<GenieChat>`-style components when AppKit ships a
 * first-class agent chat primitive in `@databricks/appkit-ui/react`.
 */
export function AgentChat() {
  const [agents, setAgents] = useState<string[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    fetch('/api/agents/info')
      .then((res) => {
        if (!res.ok) throw new Error(`agents info failed: ${res.statusText}`);
        return res.json() as Promise<AgentInfo>;
      })
      .then((info) => {
        setAgents(info.agents);
        setSelectedAgent(info.defaultAgent ?? info.agents[0] ?? null);
      })
      .catch((err) =>
        setError(err instanceof Error ? err.message : 'Failed to load agents'),
      );
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, []);

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    const message = input.trim();
    if (!message || streaming || !selectedAgent) return;

    setError(null);
    setInput('');
    setStreaming(true);

    const userMsg: Message = {
      id: `u-${Date.now()}`,
      role: 'user',
      content: message,
    };
    const assistantId = `a-${Date.now()}`;
    setMessages((prev) => [
      ...prev,
      userMsg,
      { id: assistantId, role: 'assistant', content: '' },
    ]);

    try {
      const res = await fetch('/api/agents/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message,
          agent: selectedAgent,
          threadId: threadId ?? undefined,
        }),
      });
      if (!res.ok || !res.body) {
        throw new Error(`chat failed: ${res.status} ${res.statusText}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        // SSE events are blank-line separated. Drain whole events from buf.
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const raw = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const dataLine = raw
            .split('\n')
            .find((l) => l.startsWith('data:'));
          if (!dataLine) continue;
          const json = dataLine.slice(5).trim();
          if (!json) continue;
          try {
            handleEvent(JSON.parse(json), assistantId);
          } catch {
            // Ignore malformed payloads; the SSE stream will recover.
          }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Chat error');
    } finally {
      setStreaming(false);
    }
  };

  function handleEvent(ev: unknown, assistantId: string) {
    if (!ev || typeof ev !== 'object') return;
    const e = ev as Record<string, unknown>;

    if (e.type === 'appkit.metadata') {
      const data = e.data as { threadId?: string } | undefined;
      if (data?.threadId) setThreadId(data.threadId);
      return;
    }

    if (e.type === 'response.output_text.delta') {
      const delta = (e.delta as string | undefined) ?? '';
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId ? { ...m, content: m.content + delta } : m,
        ),
      );
      return;
    }

    if (e.type === 'response.output_item.added') {
      const item = e.item as
        | { type: string; name?: string; arguments?: string }
        | undefined;
      if (item?.type === 'function_call' && item.name) {
        setMessages((prev) => [
          ...prev,
          {
            id: `t-${Date.now()}-${Math.random()}`,
            role: 'tool',
            toolName: item.name,
            content: item.arguments ?? '',
          },
        ]);
      }
    }
  }

  return (
    <div className="space-y-6 w-full max-w-4xl mx-auto">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold text-foreground">Agents</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Chat with a registered agent. Markdown agents come from
            <code className="mx-1">config/agents/</code>; code-defined
            agents are wired in <code className="mx-1">server/server.ts</code>.
          </p>
        </div>
        {agents.length > 0 && (
          <div className="flex gap-2">
            {agents.map((name) => (
              <Button
                key={name}
                variant={selectedAgent === name ? 'default' : 'outline'}
                size="sm"
                onClick={() => {
                  setSelectedAgent(name);
                  setThreadId(null);
                  setMessages([]);
                }}
              >
                {name}
              </Button>
            ))}
          </div>
        )}
      </div>

      <Card className="h-[600px] flex flex-col">
        <CardContent className="flex-1 overflow-y-auto p-4 space-y-3" ref={scrollRef}>
          {messages.length === 0 && (
            <p className="text-sm text-muted-foreground text-center mt-8">
              Start the conversation. Try asking <code>helper</code> "what
              time is it?" or "count the words in: the quick brown fox".
            </p>
          )}
          {messages.map((m) => {
            if (m.role === 'tool') {
              return (
                <div
                  key={m.id}
                  className="text-xs font-mono text-muted-foreground border-l-2 border-primary/50 pl-3"
                >
                  <span className="font-semibold">tool · {m.toolName}</span>
                  {m.content ? <span className="ml-2">{m.content}</span> : null}
                </div>
              );
            }
            return (
              <div
                key={m.id}
                className={`p-3 rounded-md ${
                  m.role === 'user'
                    ? 'bg-primary/10 ml-12'
                    : 'bg-muted mr-12'
                }`}
              >
                <div className="text-xs text-muted-foreground mb-1">
                  {m.role}
                </div>
                <div className="whitespace-pre-wrap text-sm">
                  {m.content || (streaming ? '…' : '')}
                </div>
              </div>
            );
          })}
        </CardContent>

        <form onSubmit={send} className="p-3 border-t flex gap-2">
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={
              selectedAgent
                ? `Message ${selectedAgent}…`
                : 'Loading agents…'
            }
            disabled={!selectedAgent || streaming}
          />
          <Button
            type="submit"
            disabled={!input.trim() || !selectedAgent || streaming}
          >
            {streaming ? 'Sending…' : 'Send'}
          </Button>
        </form>
      </Card>

      {error && (
        <div className="text-sm text-destructive">Error: {error}</div>
      )}
    </div>
  );
}
{{- end}}
