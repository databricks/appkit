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
    // The playground's sticky header in `__root.tsx` claims roughly
    // 69px (36+16+16+1) of vertical layout space
    <div className="h-[calc(100svh-69px)] bg-background">
      <ChatApp api="/api/agents/chat" />
    </div>
  );
}
