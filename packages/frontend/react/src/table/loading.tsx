export function LoadingSkeleton() {
  return (
    <div className="w-full space-y-3 mt-2">
      <div className="flex items-center gap-2 mt-4">
        <div className="h-10 bg-gray-200 dark:bg-gray-800 rounded animate-pulse flex-1 max-w-sm" />
        <div className="h-10 bg-gray-200 dark:bg-gray-800 rounded animate-pulse w-24 ml-auto" />
      </div>

      <div className="rounded-md border overflow-hidden">
        <div className="border-b bg-gray-50 dark:bg-gray-900 p-4">
          <div className="flex gap-4">
            <div className="h-8 bg-gray-200 dark:bg-gray-800 rounded animate-pulse flex-1" />
            <div className="h-8 bg-gray-200 dark:bg-gray-800 rounded animate-pulse flex-1" />
            <div className="h-8 bg-gray-200 dark:bg-gray-800 rounded animate-pulse flex-1" />
          </div>
        </div>

        {Array.from({ length: 5 }).map(() => (
          <div
            key={`loading-row-${Math.random()}`}
            className="border-b p-4 last:border-b-0"
          >
            <div className="flex gap-4">
              <div className="h-6 bg-gray-200 dark:bg-gray-800 rounded animate-pulse flex-1" />
              <div className="h-6 bg-gray-200 dark:bg-gray-800 rounded animate-pulse flex-1" />
              <div className="h-6 bg-gray-200 dark:bg-gray-800 rounded animate-pulse flex-1" />
            </div>
          </div>
        ))}
      </div>

      <div className="flex items-center justify-end gap-2">
        <div className="h-4 bg-gray-200 dark:bg-gray-800 rounded animate-pulse w-32" />
        <div className="h-9 bg-gray-200 dark:bg-gray-800 rounded animate-pulse w-20" />
        <div className="h-9 bg-gray-200 dark:bg-gray-800 rounded animate-pulse w-20" />
      </div>
    </div>
  );
}
