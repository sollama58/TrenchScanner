import { Prisma } from "@prisma/client";
import { createLogger, IDENTITY_BATCH_MAX, prisma } from "@trenchscanner/core";
import type { HeliusIdentity, HeliusIdentityClient, IdentityRead } from "@trenchscanner/core";
import type { WalletLabel } from "./walletProfile.js";

/**
 * Who a wallet is, from Helius's identity list (exchanges, protocols, known services), for the
 * wallet modal and the holder lists' names. Read when someone opens the wallet (or a list, in
 * batches of up to 100) and cached here and in the database, so a wallet seen again (or by someone
 * else, or after a deploy) costs nothing: each read bills 100 Helius credits.
 */

const logger = createLogger("wallet-identity");

/**
 * How long an answer is kept, in memory and in the database (user decision 2026-10-18, was 12
 * hours in memory only): exchange and protocol names don't change, and a username rarely does.
 */
export const WALLET_IDENTITY_TTL_MS = 7 * 24 * 3_600_000;

/** Where answers outlive the process: the WalletIdentity table, or a stand-in in tests. */
export interface IdentityStore {
  /** Kept answers read at or after `since`, with when each was read. */
  read(
    wallets: readonly string[],
    since: Date,
  ): Promise<Map<string, { at: number; value: HeliusIdentity | null }>>;
  write(answers: ReadonlyMap<string, HeliusIdentity | null>, at: Date): Promise<void>;
}

/** How often the database's expired answers are deleted, at most. */
const PRUNE_EVERY_MS = 60 * 60_000;

export function prismaIdentityStore(ttlMs = WALLET_IDENTITY_TTL_MS): IdentityStore {
  let lastPrune = 0;
  return {
    async read(wallets, since) {
      const rows = await prisma.walletIdentity.findMany({
        where: { wallet: { in: [...wallets] }, readAt: { gte: since } },
      });
      return new Map(
        rows.map((r) => [
          r.wallet,
          { at: r.readAt.getTime(), value: (r.identity as HeliusIdentity | null) ?? null },
        ]),
      );
    },
    async write(answers, at) {
      if (answers.size === 0) return;
      const rows = [...answers].map(
        ([wallet, value]) =>
          Prisma.sql`(${wallet}, ${value === null ? null : JSON.stringify(value)}::jsonb, ${at})`,
      );
      await prisma.$executeRaw`
        INSERT INTO "WalletIdentity" ("wallet", "identity", "readAt")
        VALUES ${Prisma.join(rows)}
        ON CONFLICT ("wallet") DO UPDATE SET "identity" = EXCLUDED."identity", "readAt" = EXCLUDED."readAt"
      `;
      if (at.getTime() - lastPrune > PRUNE_EVERY_MS) {
        lastPrune = at.getTime();
        await prisma.walletIdentity.deleteMany({ where: { readAt: { lt: new Date(at.getTime() - ttlMs) } } });
      }
    },
  };
}

/** Helius's name and tags for a wallet as the modal's labels. Exported for tests. */
export function identityLabels(identity: HeliusIdentity | null): WalletLabel[] {
  if (!identity) return [];
  const out: WalletLabel[] = [];
  const seen = new Set<string>();
  const add = (text: string, detail?: string, tone: WalletLabel["tone"] = "info") => {
    if (seen.has(text.toLowerCase())) return;
    seen.add(text.toLowerCase());
    out.push({ text, tone, source: "Helius", detail });
  };
  // A Pump.fun username shows in quotes, tinted green, as in the holder lists; a FOMO one in purple.
  if (identity.name && identity.pumpfun) {
    seen.add(identity.name.toLowerCase());
    out.push({ text: `"${identity.name}"`, tone: "pumpfun", source: "Helius", detail: "Pump.fun username" });
  } else if (identity.name && identity.fomo) {
    seen.add(identity.name.toLowerCase());
    out.push({ text: `"${identity.name}"`, tone: "fomo", source: "Helius", detail: "FOMO username" });
  } else if (identity.name) add(identity.name, identity.category ?? undefined);
  for (const tag of identity.tags) if (tag !== identity.category) add(tag);
  return out;
}

/** How long a plan that said "not on this plan" is left alone before it is asked again. */
const UNAVAILABLE_BACKOFF_MS = 60 * 60_000;

/** Who a call is charged to: one signed-in account. */
export type IdentityUserKey = string;

export interface WalletIdentityOptions {
  ttlMs: number;
  /** Calls a minute across everyone (a batch counts as one). */
  perMinute: number;
  maxEntries: number;
  /**
   * One account's share of `perMinute`, and its calls a day: one subscriber posting random lists
   * could otherwise spend the whole minute's budget (about 2,000 credits a minute) and leave
   * everyone else's lists unnamed. A bubble map is one batch call, often answered from the cache.
   */
  perUserPerMinute: number;
  perUserPerDay: number;
  /**
   * How long a list's few misses wait for others before Helius is asked (each call bills 100
   * credits however many wallets it carries): the live-trades list sends one to three new traders
   * every few seconds, so they are queued and read together, up to IDENTITY_BATCH_MAX at once.
   */
  batchWaitMs: number;
  /** A list bringing this many misses at once (a holder list, a bubble map) is read straight away. */
  askNowAt: number;
}

const DEFAULT_OPTIONS: WalletIdentityOptions = {
  ttlMs: WALLET_IDENTITY_TTL_MS,
  perMinute: 20,
  maxEntries: 5_000,
  perUserPerMinute: 4,
  perUserPerDay: 150,
  batchWaitMs: 60_000,
  askNowAt: 20,
};
/** Misses queued at most; past it a list's misses are left unread and asked again later. */
const MAX_QUEUED = 1_000;
const DAY_MS = 24 * 3_600_000;
/** Accounts whose use is remembered at once; the least recent is forgotten past it. */
const MAX_TRACKED_USERS = 5_000;

/**
 * Reads Helius's identity for a wallet at most once per TTL, with at most `perMinute` calls a
 * minute (a batch counts as one), and within each account's own share when the caller names one.
 * A plan that can't read it is skipped for an hour, then tried again. Failed reads are not cached.
 * The cache drops its least recently used entry when full, not everything at once.
 */
export class WalletIdentityReader {
  private cache = new Map<string, { at: number; value: HeliusIdentity | null }>();
  private window: number[] = [];
  /** Each account's calls in the last day, oldest first. */
  private users = new Map<IdentityUserKey, number[]>();
  private offUntil = 0;
  /** Misses waiting for the next batch, with when each was queued, oldest first. */
  private queued = new Map<string, number>();
  private flushing: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly opts: WalletIdentityOptions;

  constructor(
    private readonly helius: Pick<HeliusIdentityClient, "identity" | "batchIdentity">,
    opts: Partial<WalletIdentityOptions> = {},
    /** Answers kept across deploys and API processes; none in tests. */
    private readonly store: IdentityStore | null = null,
  ) {
    this.opts = { ...DEFAULT_OPTIONS, ...opts };
  }

  /**
   * Whether one more call fits the minute's cap, the account's share and day, and the plan isn't
   * backed off; counts it if so.
   */
  private take(now: number, user?: IdentityUserKey): boolean {
    if (!this.callFits(now)) return false;
    if (user !== undefined && !this.takeUser(now, user)) return false;
    this.window.push(now);
    return true;
  }

  /** Whether the plan isn't backed off and one more call fits the minute's cap (not counted). */
  private callFits(now: number): boolean {
    if (now < this.offUntil) return false;
    this.window = this.window.filter((t) => now - t < 60_000);
    return this.window.length < this.opts.perMinute;
  }

  /** Whether one more ask fits `user`'s share of the minute and their day; counts it if so. */
  private takeUser(now: number, user: IdentityUserKey): boolean {
    const mine = (this.users.get(user) ?? []).filter((t) => now - t < DAY_MS);
    const lastMinute = mine.filter((t) => now - t < 60_000).length;
    if (lastMinute >= this.opts.perUserPerMinute || mine.length >= this.opts.perUserPerDay) {
      this.users.set(user, mine);
      return false;
    }
    mine.push(now);
    // Re-inserted so the map stays in order of last use, and the oldest is forgotten first.
    this.users.delete(user);
    this.users.set(user, mine);
    if (this.users.size > MAX_TRACKED_USERS) {
      const oldest = this.users.keys().next().value;
      if (oldest !== undefined) this.users.delete(oldest);
    }
    return true;
  }

  /** A fresh cached answer, moved to the back so the least recently used goes first. */
  private cached(wallet: string, now: number) {
    const hit = this.cache.get(wallet);
    if (!hit || now - hit.at >= this.opts.ttlMs) return undefined;
    this.cache.delete(wallet);
    this.cache.set(wallet, hit);
    return hit;
  }

  /** Answers the database kept for `wallets`, moved into memory. A failed read is no answer. */
  private async fromStore(
    wallets: readonly string[],
    now: number,
  ): Promise<Map<string, HeliusIdentity | null>> {
    const out = new Map<string, HeliusIdentity | null>();
    if (!this.store || wallets.length === 0) return out;
    const kept = await this.store.read(wallets, new Date(now - this.opts.ttlMs)).catch((err: unknown) => {
      logger.warn("wallet identity store read failed", { error: String(err) });
      return new Map<string, { at: number; value: HeliusIdentity | null }>();
    });
    for (const [w, { at, value }] of kept) {
      this.remember(w, value, at);
      out.set(w, value);
    }
    return out;
  }

  /** Keeps fresh answers in the database too; a failed write only costs a later re-read. */
  private keep(answers: ReadonlyMap<string, HeliusIdentity | null>, now: number) {
    if (!this.store || answers.size === 0) return;
    void this.store
      .write(answers, new Date(now))
      .catch((err: unknown) => logger.warn("wallet identity store write failed", { error: String(err) }));
  }

  private remember(wallet: string, value: HeliusIdentity | null, now: number) {
    this.cache.delete(wallet);
    while (this.cache.size >= this.opts.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    this.cache.set(wallet, { at: now, value });
  }

  /** The wallet modal's one wallet: read at once (someone is looking at it), within `user`'s share. */
  async labels(wallet: string, now = Date.now(), user?: IdentityUserKey): Promise<WalletLabel[]> {
    const hit = this.cached(wallet, now);
    if (hit) return identityLabels(hit.value);
    const kept = await this.fromStore([wallet], now);
    if (kept.has(wallet)) return identityLabels(kept.get(wallet)!);
    if (!this.take(now, user)) return [];
    const res = await this.helius
      .identity(wallet)
      .catch((): IdentityRead<HeliusIdentity> => ({ status: "failed" }));
    if (res.status === "unavailable") {
      this.offUntil = now + UNAVAILABLE_BACKOFF_MS;
      return [];
    }
    if (res.status === "failed") return [];
    const value = res.status === "found" ? res.value : null;
    this.remember(wallet, value, now);
    this.keep(new Map([[wallet, value]]), now);
    return identityLabels(value);
  }

  /**
   * Helius's identity for each of `wallets` it could answer: cached ones from the cache, the rest
   * queued and read in batches of up to IDENTITY_BATCH_MAX, once the oldest has waited
   * `batchWaitMs`, the queue is full, or this list alone brings `askNowAt` misses. Queuing a list's
   * misses counts as one of `user`'s calls; each batch as one of the minute's. A wallet left out
   * was not read yet (the caller asks again later).
   */
  async identities(
    wallets: readonly string[],
    now = Date.now(),
    user?: IdentityUserKey,
  ): Promise<Map<string, HeliusIdentity | null>> {
    const out = new Map<string, HeliusIdentity | null>();
    const unread: string[] = [];
    for (const w of new Set(wallets)) {
      const hit = this.cached(w, now);
      if (hit) out.set(w, hit.value);
      else unread.push(w);
    }
    for (const [w, value] of await this.fromStore(unread, now)) out.set(w, value);
    const misses = unread.filter((w) => !out.has(w));
    if (misses.length === 0) return out;
    const fresh = misses.filter((w) => !this.queued.has(w));
    if (
      fresh.length > 0 &&
      now >= this.offUntil &&
      this.queued.size + fresh.length <= MAX_QUEUED &&
      (user === undefined || this.takeUser(now, user))
    )
      for (const w of fresh) this.queued.set(w, now);
    const oldest = this.queued.values().next().value;
    if (
      oldest !== undefined &&
      (now - oldest >= this.opts.batchWaitMs ||
        this.queued.size >= IDENTITY_BATCH_MAX ||
        misses.length >= this.opts.askNowAt)
    )
      await this.flush(now);
    else this.schedule();
    for (const w of misses) {
      const hit = this.cached(w, now);
      if (hit) out.set(w, hit.value);
    }
    return out;
  }

  /**
   * Reads the queue when its oldest has waited long enough (and the minute's cap and any back-off
   * allow), if no list asks before then.
   */
  private schedule() {
    const oldest = this.queued.values().next().value;
    if (this.timer || oldest === undefined) return;
    const capFreesAt = this.window.length >= this.opts.perMinute ? (this.window[0] ?? 0) + 60_000 : 0;
    const at = Math.max(oldest + this.opts.batchWaitMs, capFreesAt, this.offUntil);
    this.timer = setTimeout(
      () => {
        this.timer = null;
        void this.flush(Date.now());
      },
      Math.max(0, at - Date.now()),
    );
    this.timer.unref?.();
  }

  /** Reads the queue in batches, oldest first, while the minute's cap allows; the rest wait. */
  private async flush(now: number): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = (async () => {
      while (this.queued.size > 0 && this.callFits(now)) {
        const batch = [...this.queued.keys()].slice(0, IDENTITY_BATCH_MAX);
        for (const w of batch) this.queued.delete(w);
        this.window.push(now);
        const res = await this.helius
          .batchIdentity(batch)
          .catch((): IdentityRead<Map<string, HeliusIdentity | null>> => ({ status: "failed" }));
        if (res.status === "unavailable") {
          this.offUntil = now + UNAVAILABLE_BACKOFF_MS;
          this.queued.clear();
          break;
        }
        // A failed batch is dropped, not retried here: its lists ask again later.
        if (res.status !== "found") break;
        for (const [w, value] of res.value) this.remember(w, value, now);
        this.keep(res.value, now);
      }
    })().finally(() => {
      this.flushing = null;
      this.schedule();
    });
    return this.flushing;
  }

  /** Stops the queue's timer (the server closing, or a test ending). */
  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
