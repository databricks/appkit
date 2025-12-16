export function LoadingSkeleton({ height = "300px" }: { height?: string }) {
  return (
    <div className="w-full animate-pulse bg-muted rounded" style={{ height }} />
  );
}
