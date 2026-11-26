export const DEFAULT_SAMPLE_RATE = 1;

const HASH_OFFSET = 0x811c9dc5;
const HASH_PRIME = 0x01000193;
const UINT32_RANGE = 0x1_0000_0000;

export function normalizeSampleRate(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_SAMPLE_RATE;
  }

  return Math.min(1, Math.max(0, value));
}

/** Returns a stable sampling decision for a session ID and sample rate. */
export function isSessionSampled(
  sessionId: string,
  sampleRate: unknown,
): boolean {
  const normalizedRate = normalizeSampleRate(sampleRate);
  if (normalizedRate === 0) return false;
  if (normalizedRate === 1) return true;

  return hashSessionId(sessionId) / UINT32_RANGE < normalizedRate;
}

function hashSessionId(sessionId: string): number {
  let hash = HASH_OFFSET;

  for (let index = 0; index < sessionId.length; index += 1) {
    hash ^= sessionId.charCodeAt(index);
    hash = Math.imul(hash, HASH_PRIME);
  }

  return hash >>> 0;
}
