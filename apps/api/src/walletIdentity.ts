import type { HeliusIdentity, HeliusIdentityClient, IdentityRead } from "@trenchscanner/core";
import type { WalletLabel } from "./walletProfile.js";

/**
 * Who a wallet is, from Helius's identity list (exchanges, protocols, known services), for the
 * wallet modal. Read when someone opens the wallet and cached here, so a wallet opened again (or
 * by someone else) costs nothing: each read bills 100 Helius credits.
 */

/** Helius's name and tags for a wallet as the modal's labels. Exported for tests. */
export function identityLabels(identity: HeliusIdentity | null): WalletLabel[] {
  if (!identity) return [];
  const out: WalletLabel[] = [];
  const seen = new Set<string>();
  const add = (text: string, detail?: string) => {
    if (seen.has(text.toLowerCase())) return;
    seen.add(text.toLowerCase());
    out.push({ text, tone: "info", source: "Helius", detail });
  };
  if (identity.name) add(identity.name, identity.category ?? undefined);
  for (const tag of identity.tags) if (tag !== identity.category) add(tag);
  return out;
}

/** How long a plan that said "not on this plan" is left alone before it is asked again. */
const UNAVAILABLE_BACKOFF_MS = 60 * 60_000;

/**
 * Reads Helius's identity for a wallet at most once per TTL and at most `perMinute` times a minute.
 * A plan that can't read it is skipped for an hour, then tried again. Failed reads are not cached.
 */
export class WalletIdentityReader {
  private cache = new Map<string, { at: number; value: HeliusIdentity | null }>();
  private window: number[] = [];
  private offUntil = 0;

  constructor(
    private readonly helius: Pick<HeliusIdentityClient, "identity">,
    private readonly opts: { ttlMs: number; perMinute: number; maxEntries: number } = {
      ttlMs: 12 * 3_600_000,
      perMinute: 20,
      maxEntries: 5_000,
    },
  ) {}

  async labels(wallet: string, now = Date.now()): Promise<WalletLabel[]> {
    const hit = this.cache.get(wallet);
    if (hit && now - hit.at < this.opts.ttlMs) return identityLabels(hit.value);
    if (now < this.offUntil) return [];
    this.window = this.window.filter((t) => now - t < 60_000);
    if (this.window.length >= this.opts.perMinute) return [];
    this.window.push(now);
    const res = await this.helius
      .identity(wallet)
      .catch((): IdentityRead<HeliusIdentity> => ({ status: "failed" }));
    if (res.status === "unavailable") {
      this.offUntil = now + UNAVAILABLE_BACKOFF_MS;
      return [];
    }
    if (res.status === "failed") return [];
    if (this.cache.size >= this.opts.maxEntries) this.cache.clear();
    const value = res.status === "found" ? res.value : null;
    this.cache.set(wallet, { at: now, value });
    return identityLabels(value);
  }
}
