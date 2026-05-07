/**
 * Maximum serialized length of a tool result before we truncate with a
 * human-readable marker. 50k chars is roughly ~12k tokens — enough for
 * reasonable SQL result sets and JSON blobs, well short of the per-call
 * context limits on current frontier models.
 */
export const MAX_TOOL_RESULT_CHARS = 50_000;

/**
 * Normalise a raw tool-execution result for the LLM as a single string:
 *
 * - `undefined` → empty string. A `void` return is a legitimate outcome for
 *   side-effecting tools ("send notification"); surfacing `undefined` to the
 *   adapter would otherwise read as "execution failed".
 * - strings are returned as-is.
 * - `null` and every other shape are JSON-stringified (so `null` becomes
 *   the literal string `"null"`).
 * - results longer than {@link MAX_TOOL_RESULT_CHARS} are truncated and
 *   annotated so the model sees the cut rather than silent data loss.
 *
 * Always returns `string`. Earlier shapes returned the raw object for short
 * non-string results, which forced every adapter to repeat the same
 * `typeof === "string" ? : JSON.stringify(...)` dance and gave the LLM
 * different shapes for short-vs-long results without any observable benefit
 * — every downstream consumer stringified the value at the wire boundary
 * anyway.
 *
 * Pure function; safe to unit-test in isolation.
 */
export function normalizeToolResult(
  result: unknown,
  maxChars: number = MAX_TOOL_RESULT_CHARS,
): string {
  if (result === undefined) return "";
  const serialized =
    typeof result === "string" ? result : JSON.stringify(result);
  if (serialized.length > maxChars) {
    return `${serialized.slice(0, maxChars)}\n\n[Result truncated: ${serialized.length} chars exceeds ${maxChars} limit]`;
  }
  return serialized;
}
