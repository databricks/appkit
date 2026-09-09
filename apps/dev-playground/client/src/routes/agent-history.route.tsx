import { AgentThread, ThreadList } from "@databricks/appkit-ui/react/beta";
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useState } from "react";

export const Route = createFileRoute("/agent-history")({
  component: AgentHistoryRoute,
});

/**
 * Persistent chat history with the beta appkit-ui components. `<ThreadList>`
 * (left) owns the list; `<AgentThread>` (right) owns the active conversation.
 * The page holds the active thread id and wires the two together — clicking a
 * thread opens it, a new/finished turn refreshes the list. Threads persist when
 * the agents plugin uses LakebaseThreadStore (see server/index.ts).
 */
function AgentHistoryRoute() {
  // `undefined` = a fresh conversation; a string = an opened thread.
  const [activeThreadId, setActiveThreadId] = useState<string | undefined>();
  // Bumping this key remounts <AgentThread> for a clean "New" conversation.
  const [threadKey, setThreadKey] = useState(0);
  // Bumping this tells <ThreadList> to refetch (new/updated thread).
  const [listSignal, setListSignal] = useState(0);

  const openThread = useCallback((id: string) => {
    setActiveThreadId(id);
    setThreadKey((k) => k + 1);
  }, []);

  const newConversation = useCallback(() => {
    setActiveThreadId(undefined);
    setThreadKey((k) => k + 1);
  }, []);

  const refreshList = useCallback(() => setListSignal((n) => n + 1), []);

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto max-w-7xl px-6 py-12">
        <div className="mb-8">
          <h1 className="mb-2 text-3xl font-bold">Agent History</h1>
          <p className="text-base text-muted-foreground">
            <code>&lt;ThreadList&gt;</code> + <code>&lt;AgentThread&gt;</code>{" "}
            from <code>@databricks/appkit-ui/react/beta</code>. Threads persist
            across restarts when the agent uses <code>LakebaseThreadStore</code>
            .
          </p>
        </div>

        <div className="flex h-[700px] gap-6">
          <div className="w-72 shrink-0 rounded-lg border bg-card">
            <ThreadList
              activeThreadId={activeThreadId}
              onSelect={openThread}
              onNewThread={newConversation}
              refetchSignal={listSignal}
            />
          </div>
          <div className="min-w-0 flex-1 rounded-lg border bg-card">
            <AgentThread
              key={threadKey}
              threadId={activeThreadId}
              onThreadCreated={setActiveThreadId}
              onTurnComplete={refreshList}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
