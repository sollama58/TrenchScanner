/**
 * An in-process copy of answers that never change once known - a wallet's first transaction, a
 * mint's Mayhem flag, a mint whose authorities are both revoked - in front of the database tables
 * that store them.
 *
 * Those tables are read on every scan, hundreds of keys at a time, for answers the process already
 * read a minute ago and that cannot have changed since. The table stays the source of truth (and
 * what a restart starts from); this only spares re-reading it. Bounded, least recently used out
 * first, so a long-running process holds its working set and no more.
 */
export class SettledAnswers<V> {
  private readonly entries = new Map<string, V>();

  constructor(private readonly maxEntries: number) {}

  /** The answers held for `keys`; marks each one found as recently used. */
  take(keys: Iterable<string>): Map<string, V> {
    const found = new Map<string, V>();
    for (const key of keys) {
      if (!this.entries.has(key)) continue;
      const value = this.entries.get(key) as V;
      this.entries.delete(key);
      this.entries.set(key, value);
      found.set(key, value);
    }
    return found;
  }

  remember(key: string, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    if (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
  }

  /** Test seam: forget everything, as a fresh process would. */
  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
