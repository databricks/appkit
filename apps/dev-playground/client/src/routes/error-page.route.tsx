import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/error-page")({
  component: ErrorPageRoute,
});

// Throws on render: the CatchBoundary in __root.tsx shows AppKit's ErrorPage.
function ErrorPageRoute(): never {
  throw new Error("This route throws on purpose, to show AppKit's error page.");
}
