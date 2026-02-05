import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@databricks/appkit-ui/react";
import { type ErrorComponentProps, Link } from "@tanstack/react-router";

export function ErrorComponent({ error }: { error: ErrorComponentProps }) {
  return (
    <Card className="m-4">
      <CardHeader>
        <CardTitle>Something went wrong</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-gray-600 mb-4">
          {error?.error?.message || "An unexpected error occurred"}
        </p>
        <Link to="/">
          <Button variant="outline">Try again</Button>
        </Link>
      </CardContent>
    </Card>
  );
}
