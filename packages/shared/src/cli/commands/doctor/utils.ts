/** Small shared helpers for the `appkit doctor` command. */

/** Extracts a human-readable message from an unknown thrown value. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
