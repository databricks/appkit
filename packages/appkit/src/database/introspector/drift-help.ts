/**
 * Shared resolution hint for drift output. The plugin's boot warning, the
 * `appkit db verify` CLI, and any future drift surfaces all read from this
 * one place so the recommended commands stay in lock-step.
 */
export function formatDriftResolution(
  opts: { includeVerify?: boolean } = {},
): string {
  const lines = [
    "Resolve with one of:",
    "   npx appkit db migrate up",
    "   npx appkit db introspect --merge",
  ];
  if (opts.includeVerify) lines.push("   npx appkit db verify --explain");
  return lines.join("\n");
}
