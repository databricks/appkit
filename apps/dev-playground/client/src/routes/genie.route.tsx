import { GenieChat } from "@databricks/appkit-ui/react";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/genie")({
  component: GenieRoute,
});

function GenieRoute() {
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
            </p>
          </div>

          <div className="border rounded-lg h-[600px] flex flex-col">
            <GenieChat alias="demo" />
          </div>
        </div>
      </main>
    </div>
  );
}
