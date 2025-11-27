export function ErrorState({ error }: { error: string }) {
  return (
    <div className="w-full p-8 text-center">
      <p className="text-sm text-red-600 dark:text-red-400">
        Error loading table: {error}
      </p>
    </div>
  );
}
