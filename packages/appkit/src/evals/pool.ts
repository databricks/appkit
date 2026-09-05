/**
 * Run `fn` over `items` with at most `concurrency` calls in flight, preserving
 * input order in the result array. `concurrency` is clamped to `[1, length]`.
 * `fn` must not reject — a rejection abandons the other in-flight items.
 */
export async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  // Coerce a non-finite concurrency (e.g. NaN from a bad CLI `--concurrency`)
  // to 1: otherwise Math.min(NaN, len) is NaN, Array.from({length: NaN}) is [],
  // and zero workers spawn — silently skipping every item and leaving `undefined`
  // holes in the result.
  const n = Number.isFinite(concurrency) ? concurrency : 1;
  const limit = Math.max(1, Math.min(n, items.length));
  let cursor = 0;
  // Each worker pulls the next index off the shared cursor until exhausted.
  // `cursor++` is atomic between awaits (single-threaded), so no index is
  // handed to two workers.
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: limit }, () => worker()));
  return results;
}
