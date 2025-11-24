export function LoadingSkeleton({ height = "300px" }: { height?: string }) {
  return (
    <div
      className="w-full animate-pulse bg-gray-200 dark:bg-gray-800 rounded"
      style={{ height }}
    />
  );
}
