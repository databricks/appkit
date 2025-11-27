import { ErrorBoundary } from "../error-boundary";

export function TableErrorBoundary({
  children,
  fallback,
}: {
  children: React.ReactNode;
  fallback: React.ReactNode;
}) {
  return (
    <ErrorBoundary
      fallback={fallback}
      onError={(error) => console.error("Table render error:", error)}
    >
      {children}
    </ErrorBoundary>
  );
}
