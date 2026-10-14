import { IDENTITY_BATCH_MAX } from "@trenchscanner/core";
import type { HeliusIdentity, HeliusIdentityClient, IdentityRead } from "@trenchscanner/core";
import type { WalletLabel } from "./walletProfile.js";

/**
 * Who a wallet is, from Helius's identity list (exchanges, protocols, known services), for the
 * wallet modal and the holder lists' names. Read when someone opens the wallet (or a list, in
 * batches of up to 100) and cached here, so a wallet seen again (or by someone else) costs nothing:
 * each read bills Helius credits.
 */

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
}

const DEFAULT_OPTIONS: WalletIdentityOptions = {
  ttlMs: 12 * 3_600_000,
  perMinute: 20,
  maxEntries: 5_000,
  perUserPerMinute: 4,
  perUserPerDay: 150,
};
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
  private readonly opts: WalletIdentityOptions;

  constructor(
    private readonly helius: Pick<HeliusIdentityClient, "identity" | "batchIdentity">,
    opts: Partial<WalletIdentityOptions> = {},
  ) {
    this.opts = { ...DEFAULT_OPTIONS, ...opts };
  }

  /**
   * Whether one more call fits the minute's cap, the account's share and day, and the plan isn't
   * backed off; counts it if so.
   */
  private take(now: number, user?: IdentityUserKey): boolean {
    if (now < this.offUntil) return false;
    this.window = this.window.filter((t) => now - t < 60_000);
    if (this.window.length >= this.opts.perMinute) return false;
    if (user !== undefined) {
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
    }
    this.window.push(now);
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

  private remember(wallet: string, value: HeliusIdentity | null, now: number) {
    this.cache.delete(wallet);
    while (this.cache.size >= this.opts.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    this.cache.set(wallet, { at: now, value });
  }

  async labels(wallet: string, now = Date.now()): Promise<WalletLabel[]> {
    const hit = this.cached(wallet, now);
    if (hit) return identityLabels(hit.value);
    if (!this.take(now)) return [];
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
    return identityLabels(value);
  }

  /**
   * Helius's identity for each of `wallets` it could answer: cached ones from the cache, the rest
   * in batches of up to 100 while the minute's cap (and `user`'s share of it) allows. A wallet
   * left out was not read.
   */
  async identities(
    wallets: readonly string[],
    now = Date.now(),
    user?: IdentityUserKey,
  ): Promise<Map<string, HeliusIdentity | null>> {
    const out = new Map<string, HeliusIdentity | null>();
    const misses: string[] = [];
    for (const w of new Set(wallets)) {
      const hit = this.cached(w, now);
      if (hit) out.set(w, hit.value);
      else misses.push(w);
    }
    for (let i = 0; i < misses.length; i += IDENTITY_BATCH_MAX) {
      if (!this.take(now, user)) break;
      const res = await this.helius
        .batchIdentity(misses.slice(i, i + IDENTITY_BATCH_MAX))
        .catch((): IdentityRead<Map<string, HeliusIdentity | null>> => ({ status: "failed" }));
      if (res.status === "unavailable") {
        this.offUntil = now + UNAVAILABLE_BACKOFF_MS;
        break;
      }
      if (res.status !== "found") break;
      for (const [w, value] of res.value) {
        this.remember(w, value, now);
        out.set(w, value);
      }
    }
    return out;
  }
}
