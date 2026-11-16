export type BatchResult<R> =
  | { key: string; ok: true; value: R }
  | { key: string; ok: false; error: Error };

export type BatchOptions<T, R> = {
  key: (item: T) => string;
  // A stored result lets a retried step skip the call it already paid for.
  isDone: (key: string) => Promise<R | null>;
  concurrency: number;
};

const asError = (err: unknown): Error => (err instanceof Error ? err : new Error(String(err)));

/**
 * Runs `fn` over `items` with at most `concurrency` calls in flight. Failures are collected per
 * item rather than thrown, so one bad call never discards the results of its siblings.
 */
export async function runBatch<T, R>(
  items: readonly T[],
  fn: (item: T) => Promise<R>,
  { key, isDone, concurrency }: BatchOptions<T, R>,
): Promise<BatchResult<R>[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError("concurrency must be a positive integer");
  }
  const results = new Array<BatchResult<R>>(items.length);
  let next = 0;

  const worker = async () => {
    for (let i = next++; i < items.length; i = next++) {
      const item = items[i] as T;
      const k = key(item);
      try {
        const stored = await isDone(k);
        results[i] = { key: k, ok: true, value: stored ?? (await fn(item)) };
      } catch (err) {
        results[i] = { key: k, ok: false, error: asError(err) };
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}
