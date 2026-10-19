/**
 * Guards for report fills a caller can ask for by a key of their choosing (the reader's time zone,
 * say): each new key is a fill of its own, so without a bound one caller cycling through keys made
 * the API run a heavy fill per request, every one a cache miss (API audit 2026-10-19).
 */

/**
 * The distinct keys each caller may start fills for within a window. A key the caller already
 * used in the window is always allowed again; a new one only while the caller is under `maxKeys`.
 * Callers are kept least recently used first, at most `maxCallers` of them.
 */
export class CallerKeyBudget {
  private readonly callers = new Map<string, { start: number; keys: Set<string> }>();

  constructor(
    private readonly maxKeys: number,
    private readonly windowMs: number,
    private readonly maxCallers = 20_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Whether `caller` may start a fill for `key` now; counts the key when so. */
  allow(caller: string, key: string): boolean {
    const now = this.now();
    let entry = this.callers.get(caller);
    this.callers.delete(caller);
    if (!entry || now - entry.start >= this.windowMs) entry = { start: now, keys: new Set() };
    this.callers.set(caller, entry);
    while (this.callers.size > this.maxCallers) {
      const oldest = this.callers.keys().next().value;
      if (oldest === undefined) break;
      this.callers.delete(oldest);
    }
    if (entry.keys.has(key)) return true;
    if (entry.keys.size >= this.maxKeys) return false;
    entry.keys.add(key);
    return true;
  }
}

/** FillGate.run's answer when its queue is full: the caller answers without the fill. */
export class FillQueueFull extends Error {}

/**
 * At most `concurrency` fills at once, the rest waiting their turn in order; past `maxQueued`
 * waiting, run() rejects with FillQueueFull instead of queueing more.
 */
export class FillGate {
  private running = 0;
  private readonly queue: (() => void)[] = [];

  constructor(
    private readonly concurrency: number,
    private readonly maxQueued: number,
  ) {}

  async run<T>(fill: () => Promise<T>): Promise<T> {
    if (this.running >= this.concurrency) {
      if (this.queue.length >= this.maxQueued) throw new FillQueueFull();
      await new Promise<void>((resolve) => this.queue.push(resolve));
    } else {
      this.running += 1;
    }
    try {
      return await fill();
    } finally {
      // The slot passes straight to the next waiter, so `running` only drops when none waits.
      const next = this.queue.shift();
      if (next) next();
      else this.running -= 1;
    }
  }

  /** Test seam: fills running and waiting. */
  get load(): { running: number; queued: number } {
    return { running: this.running, queued: this.queue.length };
  }
}
