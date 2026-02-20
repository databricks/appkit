import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
} from "@databricks/appkit-ui/react";
import { Activity, Loader2 } from "lucide-react";
import { useId, useState } from "react";
import { useLakebaseData, useLakebasePost } from "@/hooks/use-lakebase-data";

interface ActivityLog {
  id: number;
  userId: string;
  action: string;
  metadata: Record<string, unknown> | null;
  timestamp: string;
}

interface Stats {
  totalLogs: number;
  uniqueUsers: number;
  recentActivity: number;
}

export function ActivityLogsPanel() {
  const userIdFieldId = useId();
  const actionFieldId = useId();

  const {
    data: logs,
    loading: logsLoading,
    error: logsError,
    refetch,
  } = useLakebaseData<ActivityLog[]>("/api/lakebase-examples/drizzle/activity");

  const { data: stats } = useLakebaseData<Stats>(
    "/api/lakebase-examples/drizzle/stats",
  );

  const { post, loading: creating } = useLakebasePost<
    Partial<ActivityLog>,
    ActivityLog
  >("/api/lakebase-examples/drizzle/activity");

  const generateRandomActivity = () => {
    const users = ["alice", "bob", "charlie", "diana", "eve"];
    const actions = [
      "login",
      "logout",
      "view_dashboard",
      "create_report",
      "export_data",
      "update_settings",
      "share_document",
      "delete_item",
    ];

    return {
      userId: users[Math.floor(Math.random() * users.length)],
      action: actions[Math.floor(Math.random() * actions.length)],
    };
  };

  const [formData, setFormData] = useState(generateRandomActivity());

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const result = await post({
      userId: formData.userId,
      action: formData.action,
      metadata: {
        source: "web",
        timestamp: new Date().toISOString(),
      },
    });

    if (result) {
      setFormData(generateRandomActivity());
      refetch();
    }
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <Card className="border-2">
        <CardHeader className="pb-0 gap-0">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-purple-100 rounded-lg flex-shrink-0 self-start">
              <Activity className="h-6 w-6 text-purple-600" />
            </div>
            <div className="flex-1 min-w-0">
              <CardTitle>Drizzle ORM Example</CardTitle>
              <CardDescription>
                Type-safe queries with schema definitions and automatic type
                inference
              </CardDescription>
            </div>
          </div>
        </CardHeader>
      </Card>

      {/* Statistics */}
      {stats && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card>
            <CardHeader className="pb-3">
              <CardDescription className="text-xs">Total Logs</CardDescription>
              <CardTitle className="text-2xl">{stats.totalLogs}</CardTitle>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader className="pb-3">
              <CardDescription className="text-xs">
                Unique Users
              </CardDescription>
              <CardTitle className="text-2xl">{stats.uniqueUsers}</CardTitle>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader className="pb-3">
              <CardDescription className="text-xs">
                Last 24 Hours
              </CardDescription>
              <CardTitle className="text-2xl">{stats.recentActivity}</CardTitle>
            </CardHeader>
          </Card>
        </div>
      )}

      {/* Create log form */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Log Activity</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label
                  htmlFor={userIdFieldId}
                  className="text-sm font-medium mb-1 block"
                >
                  User ID
                </label>
                <Input
                  id={userIdFieldId}
                  value={formData.userId}
                  onChange={(e) =>
                    setFormData({ ...formData, userId: e.target.value })
                  }
                  placeholder="alice"
                  required
                />
              </div>
              <div>
                <label
                  htmlFor={actionFieldId}
                  className="text-sm font-medium mb-1 block"
                >
                  Action
                </label>
                <Input
                  id={actionFieldId}
                  value={formData.action}
                  onChange={(e) =>
                    setFormData({ ...formData, action: e.target.value })
                  }
                  placeholder="view_dashboard"
                  required
                />
              </div>
            </div>
            <Button type="submit" disabled={creating} className="w-full">
              {creating ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Logging...
                </>
              ) : (
                "Log Activity"
              )}
            </Button>
          </form>
        </CardContent>
      </Card>

      {/* Activity logs */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-lg">Activity Logs</CardTitle>
            <Button variant="outline" size="sm" onClick={() => refetch()}>
              Refresh
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {logsLoading && (
            <div className="flex items-center gap-2 text-warning py-8">
              <div className="w-2 h-2 bg-amber-500 rounded-full animate-pulse" />
              Loading activity logs...
            </div>
          )}

          {logsError && (
            <div className="text-destructive bg-destructive/10 p-3 rounded-md border border-destructive/20">
              <span className="font-semibold">Error:</span> {logsError.message}
            </div>
          )}

          {logs && logs.length === 0 && (
            <div className="text-center py-12 text-muted-foreground">
              <Activity className="h-12 w-12 mx-auto mb-3 opacity-50" />
              <p>No activity logs yet. Log your first activity above.</p>
            </div>
          )}

          {logs && logs.length > 0 && (
            <div className="space-y-3 max-h-[500px] overflow-y-auto">
              {logs.map((log) => (
                <div
                  key={log.id}
                  className="p-4 bg-secondary rounded border border-border"
                >
                  <div className="flex items-start justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <Badge className="bg-purple-100 text-purple-700 border-purple-200">
                        {log.userId}
                      </Badge>
                      <span className="text-sm font-medium">{log.action}</span>
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {new Date(log.timestamp).toLocaleString()}
                    </span>
                  </div>
                  {log.metadata && (
                    <details className="text-xs text-muted-foreground">
                      <summary className="cursor-pointer">
                        View metadata
                      </summary>
                      <pre className="mt-2 p-2 bg-background rounded border overflow-x-auto">
                        {JSON.stringify(log.metadata, null, 2)}
                      </pre>
                    </details>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
