import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@databricks/appkit-ui/react";
import { Link, useRouteError } from "react-router";

export function ErrorComponent() {
  const error = useRouteError();
  const message =
    error instanceof Error ? error.message : "An unexpected error occurred";

  return (
    <Card className="m-4">
      <CardHeader>
        <CardTitle>Something went wrong</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-gray-600 mb-4">{message}</p>
        <Link to="/">
          <Button variant="outline">Try again</Button>
        </Link>
      </CardContent>
    </Card>
  );
}
