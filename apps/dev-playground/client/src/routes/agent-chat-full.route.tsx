import { ChatApp } from "@databricks/appkit-ui/react/chat";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/agent-chat-full")({
  component: AgentChatFullRoute,
});

/**
 * No-config showcase of `<ChatApp />`. For the build-your-own variant
 * that wires `useChat` by hand, see `agent.route.tsx`.
 */
function AgentChatFullRoute() {
  return (
    <div className="h-svh bg-background">
      <ChatApp api="/api/agents/chat" />
    </div>
  );
}
