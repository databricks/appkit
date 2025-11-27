import {
  createFileRoute,
  retainSearchParams,
  useNavigate,
} from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

export const Route = createFileRoute("/")({
  component: IndexRoute,
  search: {
    middlewares: [retainSearchParams(true)],
  },
});

function IndexRoute() {
  const navigate = useNavigate();

  return (
    <div className="min-h-[calc(100vh-73px)] bg-gray-50">
      <div className="max-w-6xl mx-auto px-6 py-20">
        <div className="text-center mb-16">
          <h1 className="text-5xl font-bold text-gray-900 mb-4">
            Apps SDK Playground
          </h1>
          <p className="text-xl text-gray-600 max-w-2xl mx-auto">
            Explore the capabilities of the Apps SDK with interactive examples
            and demos
          </p>
        </div>

        <div className="grid md:grid-cols-2 gap-6 max-w-4xl mx-auto mb-16">
          <Card className="p-6 hover:shadow-lg transition-shadow cursor-pointer">
            <div className="flex flex-col h-full">
              <h3 className="text-2xl font-semibold text-gray-900 mb-3">
                Analytics Dashboard
              </h3>
              <p className="text-gray-600 mb-6 flex-grow">
                Explore real-time analytics with query execution, data
                visualization, and interactive components using the Design
                System.
              </p>
              <Button
                onClick={() => navigate({ to: "/analytics" })}
                className="w-full"
              >
                Explore real-time analytics
              </Button>
            </div>
          </Card>

          <Card className="p-6 hover:shadow-lg transition-shadow cursor-pointer">
            <div className="flex flex-col h-full">
              <h3 className="text-2xl font-semibold text-gray-900 mb-3">
                Stream Reconnection
              </h3>
              <p className="text-gray-600 mb-6 flex-grow">
                Explore Server-Sent Events (SSE) stream reconnection with
                automatic Last-Event-ID tracking and resilient connection
                handling.
              </p>
              <Button
                onClick={() => navigate({ to: "/reconnect" })}
                className="w-full"
              >
                View Reconnect Demo
              </Button>
            </div>
          </Card>

          <Card className="p-6 hover:shadow-lg transition-shadow cursor-pointer">
            <div className="flex flex-col h-full">
              <h3 className="text-2xl font-semibold text-gray-900 mb-3">
                Data Visualization
              </h3>
              <p className="text-gray-600 mb-6 flex-grow">
                Explore powerful and customizable chart components from the Apps
                SDK.
              </p>
              <Button
                onClick={() => navigate({ to: "/data-visualization" })}
                className="w-full"
              >
                Explore data visualization
              </Button>
            </div>
          </Card>

          <Card className="p-6 hover:shadow-lg transition-shadow cursor-pointer">
            <div className="flex flex-col h-full">
              <h3 className="text-2xl font-semibold text-gray-900 mb-3">
                Telemetry
              </h3>
              <p className="text-gray-600 mb-6 flex-grow">
                Explore OpenTelemetry-compatible tracing and metrics examples
                with interactive demos showcasing custom observability patterns.
              </p>
              <Button
                onClick={() => navigate({ to: "/telemetry" })}
                className="w-full"
              >
                Try Telemetry Examples
              </Button>
            </div>
          </Card>
        </div>

        <div className="text-center pt-12 border-t border-gray-200">
          <p className="text-sm text-gray-500">
            built by databricks using apps sdk
          </p>
        </div>
      </div>
    </div>
  );
}
