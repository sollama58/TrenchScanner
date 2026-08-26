/**
 * Runs `fn` over `items` with at most `concurrency` operations in flight at once. Shared by every
 * external API client (DexScreenerClient, RugCheckClient) and worker job that needs to fan out
 * many independent requests without either serializing everything (slow) or firing them all at
 * once (risks tripping a provider's rate limit).
 *
 * Each `fn` call is expected to record its own result (push to an array, set into a Map, etc.) -
 * this only manages the fan-out, not result collection, since every current caller already has
 * its own natural place to put the result (usually a Map keyed by mint/wallet address) rather
 * than needing an ordered return array, which concurrent completion order can't provide anyway.
 */
export async function forEachWithConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  const workerCount = Math.min(concurrency, items.length);

  async function worker() {
    while (queue.length > 0) {
      const item = queue.shift();
      if (item === undefined) continue;
      await fn(item);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, worker));
}
