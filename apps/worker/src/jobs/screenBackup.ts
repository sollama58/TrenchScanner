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
 * of each backup endpoint in turn (chainBackupUrls), and the screen fails closed only when every
 * one fails. Trading stays on Helius.
 *
 * Paced for public nodes, which is what they usually are: small batches, one at a time, at most
 * MAX_MINTS_PER_CALL a call, and an endpoint that could not answer a batch at all (its own 429, or
 * down) rests for REST_MS while the next one is asked. Its failures
 * never strike the per-mint backoffs: those follow Helius's answer, as before.
 */

/** Mints per batch: a few RPC calls each, well inside a public node's per-request weight. */
const CHUNK = 20;
/** Most mints one call asks about; the rest wait for the next cycle, Helius permitting. */
const MAX_MINTS_PER_CALL = 60;
/** How long a backup that answered nothing is left alone. */
export const REST_MS = 60_000;

type Reader = Pick<HeliusClient, "getMayhemModeBatch" | "getLargestHoldersBatch">;

/** The free public nodes, asked after every configured endpoint: two providers, so one blocking us isn't the end. */
export const PUBLIC_CHAIN_RPCS = ["https://solana-rpc.publicnode.com", PRO_HOLDER_BACKUP_RPC];

/** The backup endpoint: the first paid CHAIN_BACKUP_RPC_URLS entry, else the public node. */
export function chainBackupUrl(env: Pick<Env, "CHAIN_BACKUP_RPC_URLS">): string {
  return (
    env.CHAIN_BACKUP_RPC_URLS.split(",")
      .map((u) => u.trim())
      .find((u) => /^https:\/\//.test(u)) ?? PRO_HOLDER_BACKUP_RPC
  );
}

/**
 * Every endpoint the screen's backup asks, in order, each once: the paid CHAIN_BACKUP_RPC_URLS,
 * SOLANA_RPC_URL and TRADING_BACKUP_RPC_URL, then the public nodes. A Helius URL among them is
 * left out: it is the provider being backed up, and stands down with it when the credits run out
 * (2026-10-25: every coin rejected "Mayhem unverified" while the one public node was refusing too).
 */
export function chainBackupUrls(
  env: Pick<Env, "CHAIN_BACKUP_RPC_URLS" | "SOLANA_RPC_URL" | "TRADING_BACKUP_RPC_URL">,
): string[] {
  const urls = [
    ...env.CHAIN_BACKUP_RPC_URLS.split(","),
    env.SOLANA_RPC_URL,
    env.TRADING_BACKUP_RPC_URL,
    ...PUBLIC_CHAIN_RPCS,
  ].map((u) => u.trim());
  return [...new Set(urls.filter((u) => /^https:\/\//.test(u) && !/helius/i.test(u)))];
}

/** One chunk's read: the answers, and whether the endpoint answered at all (a mint not on-chain yet is an answer). */
type ChunkRead<V> = { values: Map<string, V>; answered: boolean };

export class ScreenBackup {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly readers: { reader: Reader; restingUntil: number }[];
  private stats = { asked: 0, found: 0, rested: 0 };

  constructor(
    readers: Reader | readonly Reader[],
    private readonly now: () => number = Date.now,
  ) {
    this.readers = (Array.isArray(readers) ? readers : [readers as Reader]).map((reader) => ({
      reader,
      restingUntil: 0,
    }));
  }

  /** The Mayhem flags of the mints it could read; a mint left out is still unverified. */
  mayhem(mints: readonly string[]): Promise<Map<string, boolean>> {
    return this.run(mints, async (reader, chunk) => {
      const values = new Map<string, boolean>();
      let answered = false;
      for (const [mint, r] of await reader.getMayhemModeBatch(chunk)) {
        if (r.status === "found") values.set(mint, r.isMayhemMode);
        if (r.status === "found" || r.mintPending) answered = true;
      }
      return { values, answered };
    });
  }

  /** The top holders of the mints it could read. */
  holders(mints: readonly string[]): Promise<Map<string, OnChainHolders>> {
    return this.run(mints, async (reader, chunk) => {
      const values = new Map<string, OnChainHolders>();
      for (const [mint, r] of await reader.getLargestHoldersBatch(chunk)) {
        if (r.status === "found") values.set(mint, r.holders);
      }
      return { values, answered: values.size > 0 };
    });
  }

  /** Counts since the last call, for the scan's heartbeat. */
  takeStats(): { asked: number; found: number; rested: number } {
    const out = this.stats;
    this.stats = { asked: 0, found: 0, rested: 0 };
    return out;
  }

  /**
   * Runs `read` over `mints` a chunk at a time, after any call already in flight. Each endpoint is
   * asked only for what the ones before it gave no answer for; one that answered nothing rests.
   */
  private run<V>(
    mints: readonly string[],
    read: (reader: Reader, chunk: string[]) => Promise<ChunkRead<V>>,
  ): Promise<Map<string, V>> {
    const next = this.tail.then(async () => {
      const out = new Map<string, V>();
      const todo = [...new Set(mints)].slice(0, MAX_MINTS_PER_CALL);
      const counted = new Set<string>();
      for (const slot of this.readers) {
        const left = todo.filter((m) => !out.has(m));
        for (let i = 0; i < left.length && this.now() >= slot.restingUntil; i += CHUNK) {
          const chunk = left.slice(i, i + CHUNK);
          for (const m of chunk) {
            if (!counted.has(m)) this.stats.asked += 1;
            counted.add(m);
          }
          let got: ChunkRead<V>;
          try {
            got = await read(slot.reader, chunk);
          } catch (err) {
            logger.warn("backup read failed", { error: String(err) });
            got = { values: new Map(), answered: false };
          }
          for (const [k, v] of got.values) out.set(k, v);
          this.stats.found += got.values.size;
          if (!got.answered) {
            slot.restingUntil = this.now() + REST_MS;
            this.stats.rested += 1;
            logger.warn("backup RPC answered nothing - resting it", { forMs: REST_MS });
          }
        }
        if (out.size === todo.length) break;
      }
      return out;
    });
    this.tail = next.catch(() => undefined);
    return next;
  }
}
