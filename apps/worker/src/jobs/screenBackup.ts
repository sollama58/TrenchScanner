import {
  createLogger,
  PRO_HOLDER_BACKUP_RPC,
  type Env,
  type HeliusClient,
  type OnChainHolders,
} from "@trenchscanner/core";

const logger = createLogger("screen-backup");

/**
 * Another provider for the two chain reads the safety screen fails closed without: the Mayhem
 * flag and the top holders (user decision 2026-10-22, outage-429 C2 / worker-core F1). Both are
 * standard reads (getMultipleAccounts, getTokenLargestAccounts, getTokenSupply), so any RPC answers
 * them; with Helius refusing (a 429 wall, the credits running out, the breaker open, a timeout)
 * every new coin was rejected and the feed went dark. A mint Helius gave no answer for is asked
 * here, and the screen fails closed only when both fail. Trading stays on Helius.
 *
 * Paced for a public node, which is what it usually is (PRO_HOLDER_BACKUP_RPC): small batches, one
 * at a time, at most MAX_MINTS_PER_CALL a call, and after a call it could not answer at all (its
 * own 429, or down) it rests for REST_MS rather than being asked again next cycle. Its failures
 * never strike the per-mint backoffs: those follow Helius's answer, as before.
 */

/** Mints per batch: a few RPC calls each, well inside a public node's per-request weight. */
const CHUNK = 20;
/** Most mints one call asks about; the rest wait for the next cycle, Helius permitting. */
const MAX_MINTS_PER_CALL = 60;
/** How long a backup that answered nothing is left alone. */
export const REST_MS = 60_000;

type Reader = Pick<HeliusClient, "getMayhemModeBatch" | "getLargestHoldersBatch">;

/** The backup endpoint: the first paid CHAIN_BACKUP_RPC_URLS entry, else the public node. */
export function chainBackupUrl(env: Pick<Env, "CHAIN_BACKUP_RPC_URLS">): string {
  return (
    env.CHAIN_BACKUP_RPC_URLS.split(",")
      .map((u) => u.trim())
      .find((u) => /^https:\/\//.test(u)) ?? PRO_HOLDER_BACKUP_RPC
  );
}

export class ScreenBackup {
  private tail: Promise<unknown> = Promise.resolve();
  private restingUntil = 0;
  private stats = { asked: 0, found: 0, rested: 0 };

  constructor(
    private readonly reader: Reader,
    private readonly now: () => number = Date.now,
  ) {}

  /** The Mayhem flags of the mints it could read; a mint left out is still unverified. */
  mayhem(mints: readonly string[]): Promise<Map<string, boolean>> {
    return this.run(mints, async (chunk) => {
      const out = new Map<string, boolean>();
      for (const [mint, r] of await this.reader.getMayhemModeBatch(chunk)) {
        if (r.status === "found") out.set(mint, r.isMayhemMode);
      }
      return out;
    });
  }

  /** The top holders of the mints it could read. */
  holders(mints: readonly string[]): Promise<Map<string, OnChainHolders>> {
    return this.run(mints, async (chunk) => {
      const out = new Map<string, OnChainHolders>();
      for (const [mint, r] of await this.reader.getLargestHoldersBatch(chunk)) {
        if (r.status === "found") out.set(mint, r.holders);
      }
      return out;
    });
  }

  /** Counts since the last call, for the scan's heartbeat. */
  takeStats(): { asked: number; found: number; rested: number } {
    const out = this.stats;
    this.stats = { asked: 0, found: 0, rested: 0 };
    return out;
  }

  /** Runs `read` over `mints` a chunk at a time, after any call already in flight. */
  private run<V>(
    mints: readonly string[],
    read: (chunk: string[]) => Promise<Map<string, V>>,
  ): Promise<Map<string, V>> {
    const next = this.tail.then(async () => {
      const out = new Map<string, V>();
      const todo = [...new Set(mints)].slice(0, MAX_MINTS_PER_CALL);
      for (let i = 0; i < todo.length && this.now() >= this.restingUntil; i += CHUNK) {
        const chunk = todo.slice(i, i + CHUNK);
        this.stats.asked += chunk.length;
        let got: Map<string, V>;
        try {
          got = await read(chunk);
        } catch (err) {
          logger.warn("backup read failed", { error: String(err) });
          got = new Map();
        }
        for (const [k, v] of got) out.set(k, v);
        this.stats.found += got.size;
        if (got.size === 0) {
          this.restingUntil = this.now() + REST_MS;
          this.stats.rested += 1;
          logger.warn("backup RPC answered nothing - resting it", { forMs: REST_MS });
        }
      }
      return out;
    });
    this.tail = next.catch(() => undefined);
    return next;
  }
}
