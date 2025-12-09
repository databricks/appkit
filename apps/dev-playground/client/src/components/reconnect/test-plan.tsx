import { Card } from "@databricks/app-kit-ui/react";

export function TestPlan() {
  return (
    <Card className="p-6 h-full">
      <h3 className="text-xl font-semibold mb-4">Test Plan</h3>

      <div className="flex flex-col gap-5">
        <div>
          <p className="font-semibold mb-1">1. Stream Initialization</p>
          <p className="text-sm text-gray-500">
            Stream starts, sends message every 3 seconds
          </p>
        </div>

        <div>
          <p className="font-semibold mb-1">2. Simulated Disconnect</p>
          <p className="text-sm text-gray-500">
            After receiving 2 messages (~6 seconds), client disconnects
          </p>
        </div>

        <div>
          <p className="font-semibold mb-1">3. Automatic Reconnection</p>
          <p className="text-sm text-gray-500">
            After 3 seconds, client reconnects with Last-Event-ID
          </p>
        </div>

        <div>
          <p className="font-semibold mb-1">4. Resume Stream</p>
          <p className="text-sm text-muted-foreground">
            Should receive remaining messages (3, 4, 5)
          </p>
        </div>

        <div className="mt-1 p-4 bg-secondary rounded border border-gray-200">
          <p className="font-semibold text-sm mb-2">💡 Key Feature</p>
          <p className="text-sm text-muted-foreground">
            The stream resumes exactly where it left off using the Last-Event-ID
            header, ensuring no messages are lost during reconnection.
          </p>
        </div>
      </div>
    </Card>
  );
}
