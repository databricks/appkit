import { Button, GenieChat } from "@databricks/appkit-ui/react";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

export const Route = createFileRoute("/genie")({
  component: GenieRoute,
});

type Mode = "chat" | "agent";

// Genie plugin aliases configured in server/index.ts.
const ALIASES: Record<Mode, string> = { chat: "demo", agent: "agent" };

function GenieRoute() {
  const [mode, setMode] = useState<Mode>(() =>
    new URLSearchParams(window.location.search).get("mode") === "agent"
      ? "agent"
      : "chat",
  );

  const switchMode = (next: Mode) => {
    // Chat and agent mode don't share conversations.
    const url = new URL(window.location.href);
    url.searchParams.set("mode", next);
    url.searchParams.delete("conversationId");
    window.history.replaceState({}, "", url.toString());
    setMode(next);
  };

  return (
    <div className="min-h-screen bg-background">
      <main className="max-w-4xl mx-auto px-6 py-12">
        <div className="flex flex-col gap-6">
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-foreground">
              Genie Chat
            </h1>
            <p className="text-muted-foreground mt-2">
              Ask natural language questions about your data using AI/BI Genie.
              Agent mode shows the agent's reasoning and its charts.
            </p>
          </div>

          <div className="flex gap-2">
            <Button
              size="sm"
              variant={mode === "chat" ? "default" : "outline"}
              onClick={() => switchMode("chat")}
            >
              Chat
            </Button>
            <Button
              size="sm"
              variant={mode === "agent" ? "default" : "outline"}
              onClick={() => switchMode("agent")}
            >
              Agent
            </Button>
          </div>

          <div className="border rounded-lg h-[600px] flex flex-col">
            <GenieChat key={mode} alias={ALIASES[mode]} />
          </div>
        </div>
      </main>
    </div>
  );
}
