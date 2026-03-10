import { AgentChat } from "@databricks/appkit-ui/react";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/agent")({
  component: AgentChatRoute,
});

function AgentChatRoute() {
  return (
    <div className="min-h-screen bg-background">
      <main className="max-w-2xl mx-auto px-6 py-12 flex flex-col h-[calc(100vh-6rem)]">
        <div className="mb-6">
          <h1 className="text-3xl font-bold tracking-tight text-foreground">
            Agent Chat
          </h1>
          <p className="text-muted-foreground mt-1">
            Chat with the agent via <code>POST /invocations</code> (Responses
            API SSE stream).
          </p>
        </div>

        <AgentChat
          invokeUrl="/invocations"
          placeholder="Type a message..."
          emptyMessage="Send a message to start."
          className="flex-1 min-h-0"
        />
      </main>
    </div>
  );
}
