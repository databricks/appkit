import { MultiGenieChat } from "@databricks/appkit-ui/react";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/multi-genie")({
  component: MultiGenieRoute,
});

function MultiGenieRoute() {
  return (
    <div className="min-h-screen bg-background">
      <main className="max-w-4xl mx-auto px-6 py-12">
        <div className="flex flex-col gap-6">
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-foreground">
              Multi-Genie Chat
            </h1>
            <p className="text-muted-foreground mt-2">
              Ask questions that span multiple data domains. The supervisor
              agent routes sub-questions to the appropriate Genie spaces and
              synthesizes a unified answer.
            </p>
          </div>

          <div className="border rounded-lg h-[600px] flex flex-col">
            <MultiGenieChat />
          </div>
        </div>
      </main>
    </div>
  );
}
