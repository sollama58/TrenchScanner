import type { CardCreatorFee } from "./curatedFeed.js";
import type { OtcRewardCoin } from "./feeDesks.js";
import type { FeeWalletName } from "./feeRecipients.js";

/**
 * Where a Stonks coin's fees go (user ask 2026-10-23), from StonkFun's public API
 * (GET https://www.stonkfun.xyz/api/public/v1/tokens/{mint}, no key, 300 requests a minute).
 * TokenSage reads Pump.fun's fee config only, so a Stonks card had no fee badge before.
 *
 * - `mode: "reward"`: a holder-rewards launch. The mint carries a Token-2022 transfer fee
 *   (`transferFee.bps`, 100 or 300) that Stonk swaps into the pair's quote coin and pays to
 *   holders. A Community Mode coin sends part of each payout to the quote coin's holders.
 * - `mode: "standardV2"`: taxed the same way, with `feeRecipients.shareBps` of the tax going to
 *   fee recipients (the creator by default) before holders.
 * - `mode: "standard"`: no transfer fee. Stonk forwards the creator's share of the pool fee to
 *   the `creator` wallet: a dev-fee coin.
 *
 * A launch's mode is fixed at creation, so an answer is kept for a day. A 404 (not a Stonk
 * pool) is kept for an hour, and a failed read is not kept.
 */

const BASE = "https://www.stonkfun.xyz/api/public/v1";
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SYMBOL = /^\$?[A-Za-z0-9][A-Za-z0-9._-]{0,19}$/;
const HIT_MS = 24 * 60 * 60_000;
const MISS_MS = 60 * 60_000;
const TIMEOUT_MS = 2_500;
const MAX_KEPT = 4_000;
/** At most this many reads at once, so a feed of new Stonks coins never bursts the host. */
const MAX_PARALLEL = 8;

export interface StonkLaunchFee {
  mode: "reward" | "standardV2" | "standard";
  /** The transfer tax in basis points on a taxed launch (300 is 3%). */
  taxBps: number | null;
  /** The coin holder rewards are paid in: the pair's quote coin. */
  reward: OtcRewardCoin | null;
  /** The launch's creator wallet, when Stonk names one. */
  creator: string | null;
  /** standardV2: the share of the tax fee recipients take before holders, in basis points. */
  creatorShareBps: number | null;
  /** Community Mode: the share of each payout sent to the quote coin's holders, in basis points. */
  communityShareBps: number | null;
}

function obj(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function bpsOf(value: unknown): number | null {
  const bps = obj(value)?.bps ?? obj(value)?.shareBps;
  return typeof bps === "number" && Number.isInteger(bps) && bps > 0 && bps <= 10_000 ? bps : null;
}

function address(value: unknown): string | null {
  return typeof value === "string" && BASE58.test(value) ? value : null;
}

/** One coin's fee routing from the single-token answer; null for anything else. */
export function stonkLaunchFeeFromBody(body: unknown): StonkLaunchFee | null {
  const data = obj(obj(body)?.data);
  const token = obj(data?.token);
  if (!token) return null;
  const launch = obj(data?.launch);
  const mode = token.mode ?? launch?.mode;
  if (mode !== "reward" && mode !== "standardV2" && mode !== "standard") return null;
  const quote = obj(token.quote) ?? obj(launch?.quote);
  const quoteMint = address(quote?.mint);
  const symbol =
    typeof quote?.symbol === "string" && SYMBOL.test(quote.symbol.trim()) ? quote.symbol.trim() : null;
  const taxBps = bpsOf(token.transferFee) ?? bpsOf(launch?.transferFee);
  return {
    mode,
    taxBps: mode === "standard" ? null : taxBps,
    reward:
      mode !== "standard" && (quoteMint || symbol)
        ? { label: symbol ?? short(quoteMint!), mint: quoteMint }
        : null,
    creator: address(token.creator) ?? address(launch?.creator),
    creatorShareBps: mode === "standardV2" ? bpsOf(token.feeRecipients) : null,
    communityShareBps: mode === "reward" ? bpsOf(token.communityMode) : null,
  };
}

const kept = new Map<string, { fee: StonkLaunchFee | null; until: number }>();
const reading = new Map<string, Promise<StonkLaunchFee | null>>();

/** The kept answer: the fee, null for not a Stonk pool, undefined when nothing fresh is kept. */
export function keptStonkLaunchFee(mint: string, now = Date.now()): StonkLaunchFee | null | undefined {
  const hit = kept.get(mint);
  return hit && hit.until > now ? hit.fee : undefined;
}

async function readOne(mint: string, fetchImpl: typeof fetch): Promise<StonkLaunchFee | null> {
  const res = await fetchImpl(`${BASE}/tokens/${encodeURIComponent(mint)}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 404) {
    kept.set(mint, { fee: null, until: Date.now() + MISS_MS });
    return null;
  }
  if (!res.ok) throw new Error(`stonkfun ${res.status}`);
  const fee = stonkLaunchFeeFromBody(await res.json());
  kept.set(mint, { fee, until: Date.now() + (fee ? HIT_MS : MISS_MS) });
  while (kept.size > MAX_KEPT) {
    const oldest = kept.keys().next().value;
    if (oldest === undefined) break;
    kept.delete(oldest);
  }
  return fee;
}

function start(mint: string, fetchImpl: typeof fetch): Promise<StonkLaunchFee | null> {
  const pending = reading.get(mint);
  if (pending) return pending;
  const read = readOne(mint, fetchImpl)
    .catch(() => null)
    .finally(() => reading.delete(mint));
  reading.set(mint, read);
  return read;
}

/**
 * The fee routing of each Stonks coin in `mints` that StonkFun answered for. `wait` holds for
 * the reads (the token page). A feed does not: it answers from what is kept and reads the rest
 * behind the request, for the next poll. A supplied fetch is the host (tests); the test runner
 * otherwise never calls it.
 */
export async function stonkLaunchFees(
  mints: readonly string[],
  opts?: { wait?: boolean; fetch?: typeof fetch },
): Promise<Map<string, StonkLaunchFee>> {
  const out = new Map<string, StonkLaunchFee>();
  const todo: string[] = [];
  for (const mint of new Set(mints)) {
    if (!BASE58.test(mint)) continue;
    const hit = keptStonkLaunchFee(mint);
    if (hit) out.set(mint, hit);
    else if (hit === undefined) todo.push(mint);
  }
  if (todo.length === 0) return out;
  if (!opts?.fetch && process.env.VITEST === "true") return out;
  const fetchImpl = opts?.fetch ?? fetch;
  const run = async () => {
    for (let i = 0; i < todo.length; i += MAX_PARALLEL) {
      const batch = todo.slice(i, i + MAX_PARALLEL);
      const fees = await Promise.all(batch.map((mint) => start(mint, fetchImpl)));
      batch.forEach((mint, n) => {
        if (fees[n]) out.set(mint, fees[n]!);
      });
    }
  };
  if (opts?.wait) await run();
  else void run().catch(() => undefined);
  return out;
}

/** Test seam: forget every kept answer. */
export function clearStonkLaunchFees(): void {
  kept.clear();
  reading.clear();
}

function pct(bps: number): string {
  return `${(bps / 100).toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}%`;
}

function short(address: string): string {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

/**
 * The sentence a card's fee badge and token details show for a Stonks coin. A taxed launch's
 * reward coin is named by `stonkRewardLine`, which follows this sentence.
 */
export function stonkFeeSummary(fee: StonkLaunchFee, creatorLabel: string | null): string {
  if (fee.mode === "standard") {
    return creatorLabel ? `creator fees go to the dev, ${creatorLabel}` : "creator fees go to the dev";
  }
  const parts = [
    fee.taxBps ? `a ${pct(fee.taxBps)} transfer tax pays holders` : "a transfer tax pays holders",
  ];
  if (fee.creatorShareBps) parts.push(`${pct(fee.creatorShareBps)} of the tax goes to the creator first`);
  if (fee.communityShareBps)
    parts.push(`${pct(fee.communityShareBps)} of each payout goes to the quote coin's holders`);
  return parts.join("; ");
}

/** "Stonk pays holder rewards in SPYX.", the same shape as OTC Desks' sentence. */
export function stonkRewardLine(fee: StonkLaunchFee): string {
  return fee.reward?.label
    ? `Stonk pays holder rewards in ${fee.reward.label}.`
    : "Stonk pays holder rewards.";
}

/**
 * A Stonks coin's card fee (user ask 2026-10-23). A taxed launch is a holder-rewards coin: the
 * gift, its tax, and the reward coin's logo, with Stonk as the host that pays it. A standard
 * launch pays the dev: the chef's hat, naming the creator wallet when TrenchScanner knows it.
 */
export function stonkCardFee(fee: StonkLaunchFee, creatorName?: FeeWalletName): CardCreatorFee {
  if (fee.mode === "standard") {
    const label = fee.creator ? short(fee.creator) : null;
    const name = creatorName?.name?.trim();
    return {
      destination: "creator",
      summary: stonkFeeSummary(fee, label && name ? `${name} (${label})` : label),
      bps: null,
      recipients: label
        ? [
            {
              label,
              bps: null,
              ...(name ? { name } : {}),
              ...(name && creatorName?.avatar ? { avatar: creatorName.avatar } : {}),
              ...(name && creatorName?.kol ? { kol: true } : {}),
            },
          ]
        : null,
      deskLine: null,
      deskRewards: null,
    };
  }
  return {
    destination: "holder_rewards",
    summary: stonkFeeSummary(fee, null),
    bps: fee.taxBps,
    recipients: null,
    deskLine: stonkRewardLine(fee),
    deskRewards: fee.reward ? [fee.reward] : null,
    rewardHost: "Stonk",
  };
}
