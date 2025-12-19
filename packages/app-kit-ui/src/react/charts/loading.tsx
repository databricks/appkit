export function LoadingSkeleton({
  height = 300,
}: {
  height?: number | string;
}) {
  return (
    <div className="w-full animate-pulse bg-muted rounded" style={{ height }} />
  );
}
