{{if .plugins.agents -}}
import { useEffect, useRef, useState } from 'react';
import {
  type AgentChatEvent,
  Button,
  Card,
  CardContent,
  Input,
  useAgentChat,
  usePluginClientConfig,
} from '@databricks/appkit-ui/react';

interface Message {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolName?: string;
}

/**
 * Shape of the agents plugin's `clientConfig()` payload — exposed by
 * the agents plugin at server startup and inlined into the boot HTML
 * via `<script id="__appkit__">`. Read with `usePluginClientConfig` so
 * the page doesn't need a separate `GET /api/agents/info` round-trip.
 */
interface AgentsClientConfig {
  agents: string[];
  defaultAgent: string | null;
}

/**
 * Minimal chat surface for the `agents` plugin.
 *
 * - Reads the registered agent list from `usePluginClientConfig('agents')`
 *   (boot-time, no extra fetch) and lets the user pick one. The template
 *   ships with a single code-defined `helper` agent (`server/agents/helper.ts`);
 *   drop a `config/agents/<id>/agent.md` to add markdown-defined agents
 *   and they appear here automatically.
 * - Sends turns via `useAgentChat()` (POSTs `/api/agents/chat` and
 *   consumes the Responses-API SSE stream the agents plugin emits).
 * - Renders streaming assistant text incrementally and surfaces tool
 *   calls as separate inline rows.
 */
export function AgentChat() {
  // Agent registry comes from the agents plugin's `clientConfig()` payload
  // (boot-time, no fetch). `defaultAgent` is null only when the agents
  // plugin loaded with no registered agents.
  const { agents, defaultAgent } =
    usePluginClientConfig<AgentsClientConfig>('agents');
  const [selectedAgent, setSelectedAgent] = useState<string | null>(
    defaultAgent ?? agents[0] ?? null,
  );
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [pendingAssistantId, setPendingAssistantId] = useState<string | null>(
    null,
  );
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Surface tool-call events as inline messages. `content` from the hook
  // is the streaming text body, mirrored into the pending assistant row
  // by the effect below.
  const handleEvent = (event: AgentChatEvent) => {
    if (
      event.type === 'response.output_item.added' &&
      event.item?.type === 'function_call' &&
      event.item.name
    ) {
      setMessages((prev) => [
        ...prev,
        {
          id: `t-${Date.now()}-${Math.random()}`,
          role: 'tool',
          toolName: event.item?.name,
          content: event.item?.arguments ?? '',
        },
      ]);
    }
  };

  const { content, isStreaming, error, send, reset } = useAgentChat({
    agent: selectedAgent ?? '',
    onEvent: handleEvent,
  });

  // Mirror the streaming `content` into the pending assistant message so
  // existing tool-call rows interleave correctly with deltas.
  useEffect(() => {
    if (!pendingAssistantId) return;
    setMessages((prev) =>
      prev.map((m) =>
        m.id === pendingAssistantId ? { ...m, content } : m,
      ),
    );
  }, [content, pendingAssistantId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const message = input.trim();
    if (!message || isStreaming || !selectedAgent) return;

    setInput('');

    const assistantId = `a-${Date.now()}`;
    setMessages((prev) => [
      ...prev,
      { id: `u-${Date.now()}`, role: 'user', content: message },
      { id: assistantId, role: 'assistant', content: '' },
    ]);
    setPendingAssistantId(assistantId);

    await send(message);
    setPendingAssistantId(null);
  };

  return (
    <div className="space-y-6 w-full max-w-4xl mx-auto">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold text-foreground">Agents</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Chat with a registered agent. Code-defined agents live in
            <code className="mx-1">server/agents/</code> and are wired in
            <code className="mx-1">server/server.ts</code>; drop a
            <code className="mx-1">config/agents/&lt;id&gt;/agent.md</code>
            to add a markdown-defined agent (it'll show up here on the next boot).
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
                  setMessages([]);
                  setPendingAssistantId(null);
                  reset();
                }}
              >
                {name}
              </Button>
            ))}
          </div>
        )}
      </div>

      <Card className="h-[600px] flex flex-col">
        <CardContent
          className="flex-1 overflow-y-auto p-4 space-y-3"
          ref={scrollRef}
        >
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
                  {m.content || (isStreaming ? '…' : '')}
                </div>
              </div>
            );
          })}
        </CardContent>

        <form onSubmit={handleSubmit} className="p-3 border-t flex gap-2">
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={
              selectedAgent
                ? `Message ${selectedAgent}…`
                : 'No agents registered'
            }
            disabled={!selectedAgent || isStreaming}
          />
          <Button
            type="submit"
            disabled={!input.trim() || !selectedAgent || isStreaming}
          >
            {isStreaming ? 'Sending…' : 'Send'}
          </Button>
        </form>
      </Card>

      {error && <div className="text-sm text-destructive">Error: {error}</div>}
    </div>
  );
}
{{- end}}
