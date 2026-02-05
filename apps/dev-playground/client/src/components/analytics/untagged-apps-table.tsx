import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@databricks/appkit-ui/react";
import { AppsDataTable } from "@/components/apps-data-table";

interface UntaggedApp {
  id: string;
  name: string;
  creator: string;
  spend: number;
  avgSpend: number;
  status: "untagged";
  tags: string[];
  lastRun: string;
}

interface UntaggedAppsTableProps {
  data: UntaggedApp[];
  loading: boolean;
  error: string | null;
}

export function UntaggedAppsTable({
  data,
  loading,
  error,
}: UntaggedAppsTableProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Untagged Apps</CardTitle>
        <CardDescription>
          {loading
            ? "Loading..."
            : error
              ? "Error loading untagged apps"
              : data.length > 0
                ? `${data.length} app(s) need tagging for better cost tracking`
                : "All apps are properly tagged! 🎉"}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {error ? (
          <div className="p-10 text-center">
            <p className="text-sm text-destructive">
              Error loading untagged apps: {error}
            </p>
          </div>
        ) : data.length === 0 && !loading ? (
          <div className="p-10 text-center">
            <p className="text-sm text-green-500">
              ✓ All apps have proper tags
            </p>
          </div>
        ) : (
          <AppsDataTable data={data} loading={loading} />
        )}
      </CardContent>
    </Card>
  );
}
