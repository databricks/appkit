/**
 * Maximum serialized length of a tool result before we truncate with a
 * human-readable marker. 50k chars is roughly ~12k tokens — enough for
 * reasonable SQL result sets and JSON blobs, well short of the per-call
 * context limits on current frontier models.
 */
export const MAX_TOOL_RESULT_CHARS = 50_000;

/**
 * Normalise a raw tool-execution result for the LLM:
 *
 * - `undefined` → empty string. A `void` return is a legitimate outcome for
 *   side-effecting tools ("send notification"); surfacing `undefined` to the
 *   adapter would otherwise read as "execution failed".
 * - strings are returned as-is.
 * - everything else is JSON-stringified.
 * - results longer than {@link MAX_TOOL_RESULT_CHARS} are truncated and
 *   annotated so the model sees the cut rather than silent data loss.
 *
 * Pure function; safe to unit-test in isolation.
 */
export function normalizeToolResult(
  result: unknown,
  maxChars: number = MAX_TOOL_RESULT_CHARS,
): unknown {
  if (result === undefined) return "";
  const serialized =
    typeof result === "string" ? result : JSON.stringify(result);
  if (serialized.length > maxChars) {
    return `${serialized.slice(0, maxChars)}\n\n[Result truncated: ${serialized.length} chars exceeds ${maxChars} limit]`;
  }
  return result;
}
