import { Component } from "react";

class ErrorBoundary extends Component<
  {
    children: React.ReactNode;
    fallback: React.ReactNode;
    onError: (error: Error) => void;
  },
  { hasError: boolean }
> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: Error) {
    this.props.onError(error);
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback;
    }
    return this.props.children;
  }
}

/**
 * Error boundary component for charts
 * @param children - The children to render
 * @param fallback - The fallback component to render when an error occurs
 * @returns - The rendered chart component with error boundary
 */
export function ChartErrorBoundary({
  children,
  fallback,
}: {
  children: React.ReactNode;
  fallback: React.ReactNode;
}) {
  return (
    <ErrorBoundary
      fallback={fallback}
      onError={(error) => console.error("Chart render error:", error)}
    >
      {children}
    </ErrorBoundary>
  );
}
