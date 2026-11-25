import { FileQuestionMark, TriangleAlert } from "lucide-react";

import { Button } from "./ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "./ui/empty";

/** Props for {@link ErrorPage}. */
export interface ErrorPageProps {
  /**
   * What the route threw: an `Error`, a route error response such as React
   * Router's 404 (`{ status, statusText, data }`), or any other value.
   */
  error: unknown;
}

interface RouteErrorResponse {
  status: number;
  statusText: string;
  data?: unknown;
}

// The shape React Router's isRouteErrorResponse checks: appkit-ui doesn't depend on a router.
function isRouteErrorResponse(error: unknown): error is RouteErrorResponse {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof error.status === "number" &&
    "statusText" in error &&
    typeof error.statusText === "string"
  );
}

function details(error: unknown): string {
  if (isRouteErrorResponse(error)) {
    const data = typeof error.data === "string" ? `\n${error.data}` : "";
    return `${error.status} ${error.statusText}${data}`;
  }
  if (error instanceof Error) {
    const { message, stack = "" } = error;
    // V8's stack starts with the message; Firefox's and Safari's don't.
    return stack.includes(message) ? stack : `${message}\n${stack}`;
  }
  return String(error);
}

/**
 * The page for a route that failed, instead of the router's built-in one: it
 * says plainly that something went wrong (for a 404 route error response, that
 * the page was not found) and offers a reload and the home page. The error's
 * message and stack show only in development, never in a production build.
 *
 * Works with any router: pass React Router's `useRouteError()`, or the `error`
 * TanStack Router gives an `errorComponent`.
 */
export function ErrorPage({ error }: ErrorPageProps) {
  const notFound = isRouteErrorResponse(error) && error.status === 404;
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          {notFound ? <FileQuestionMark /> : <TriangleAlert />}
        </EmptyMedia>
        <EmptyTitle>
          {notFound ? "Page not found" : "Something went wrong"}
        </EmptyTitle>
        <EmptyDescription>
          {notFound
            ? "There is no page at this address."
            : "An unexpected error occurred. Reload the page, or go back to the home page."}
        </EmptyDescription>
      </EmptyHeader>
      {import.meta.env.DEV && (
        <pre className="bg-muted text-muted-foreground max-h-80 w-full max-w-2xl overflow-auto rounded-md p-3 text-left text-xs whitespace-pre-wrap">
          {details(error)}
        </pre>
      )}
      <EmptyContent className="flex-row justify-center">
        {!notFound && (
          <Button onClick={() => window.location.reload()}>Reload</Button>
        )}
        <Button variant="outline" asChild>
          <a href="/">Back to home</a>
        </Button>
      </EmptyContent>
    </Empty>
  );
}
