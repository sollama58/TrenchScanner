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
  // A Pump.fun username shows in quotes, tinted green, as in the holder lists.
  if (identity.name && identity.pumpfun) {
    seen.add(identity.name.toLowerCase());
    out.push({ text: `"${identity.name}"`, tone: "pumpfun", source: "Helius", detail: "Pump.fun username" });
  } else if (identity.name) add(identity.name, identity.category ?? undefined);
  for (const tag of identity.tags) if (tag !== identity.category) add(tag);
  return out;
}

/** How long a plan that said "not on this plan" is left alone before it is asked again. */
const UNAVAILABLE_BACKOFF_MS = 60 * 60_000;

/**
 * Reads Helius's identity for a wallet at most once per TTL, with at most `perMinute` calls a
 * minute (a batch counts as one).
 * A plan that can't read it is skipped for an hour, then tried again. Failed reads are not cached.
 */
export class WalletIdentityReader {
  private cache = new Map<string, { at: number; value: HeliusIdentity | null }>();
  private window: number[] = [];
  private offUntil = 0;

  constructor(
    private readonly helius: Pick<HeliusIdentityClient, "identity" | "batchIdentity">,
    private readonly opts: { ttlMs: number; perMinute: number; maxEntries: number } = {
      ttlMs: 12 * 3_600_000,
      perMinute: 20,
      maxEntries: 5_000,
    },
  ) {}

  /** Whether one more call fits the minute's cap and the plan isn't backed off; counts it if so. */
  private take(now: number): boolean {
    if (now < this.offUntil) return false;
    this.window = this.window.filter((t) => now - t < 60_000);
    if (this.window.length >= this.opts.perMinute) return false;
    this.window.push(now);
    return true;
  }

  private remember(wallet: string, value: HeliusIdentity | null, now: number) {
    if (this.cache.size >= this.opts.maxEntries) this.cache.clear();
    this.cache.set(wallet, { at: now, value });
  }

  async labels(wallet: string, now = Date.now()): Promise<WalletLabel[]> {
    const hit = this.cache.get(wallet);
    if (hit && now - hit.at < this.opts.ttlMs) return identityLabels(hit.value);
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
   * in batches of up to 100 while the minute's cap allows. A wallet left out was not read.
   */
  async identities(
    wallets: readonly string[],
    now = Date.now(),
  ): Promise<Map<string, HeliusIdentity | null>> {
    const out = new Map<string, HeliusIdentity | null>();
    const misses: string[] = [];
    for (const w of new Set(wallets)) {
      const hit = this.cache.get(w);
      if (hit && now - hit.at < this.opts.ttlMs) out.set(w, hit.value);
      else misses.push(w);
    }
    for (let i = 0; i < misses.length; i += IDENTITY_BATCH_MAX) {
      if (!this.take(now)) break;
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
