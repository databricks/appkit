import { createFileRoute, retainSearchParams } from "@tanstack/react-router";
import { useState } from "react";
import {
  ConnectionStatus,
  MessageStream,
  PageHeader,
  TestPlan,
} from "@/components/reconnect";
import { useReconnectStream } from "@/hooks/use-reconnect-stream";

export const Route = createFileRoute("/reconnect")({
  component: ReconnectRoute,
  search: {
    middlewares: [retainSearchParams(true)],
  },
});

function ReconnectRoute() {
  const [resetTrigger, setResetTrigger] = useState(0);
  const { messages, status } = useReconnectStream(
    "/api/reconnect/stream",
    resetTrigger,
  );

  const handleRestart = () => {
    setResetTrigger((prev) => prev + 1);
  };

  return (
    <div className="min-h-[calc(100vh-73px)] bg-gray-50">
      <div className="max-w-[1200px] mx-auto px-6 py-12">
        <PageHeader />

        <ConnectionStatus
          status={status}
          messageCount={messages.length}
          onRestart={handleRestart}
        />

        <div className="grid grid-cols-2 gap-6">
          <MessageStream messages={messages} />
          <TestPlan />
        </div>
      </div>

      <style>{`
        @keyframes slideIn {
          from {
            opacity: 0;
            transform: translateX(-20px);
          }
          to {
            opacity: 1;
            transform: translateX(0);
          }
        }
      `}</style>
    </div>
  );
}
