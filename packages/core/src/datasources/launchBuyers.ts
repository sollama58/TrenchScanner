/**
 * Who bought a launch first, read from the chain rather than from a live trade stream.
 *
 * The first-15-buyers count (TradeFlowFeatures.firstBuyersHolding) used to come only from the
 * PumpPortal trade stream, which had to be connected at the moment of launch - and the stream
 * stopped sending trades altogether without a funded API key, so every token read "launch not
 * seen". The launch is on chain for good, though: the mint's earliest transactions ARE the
 * launch, and one Helius getTransactionsForAddress call (sortOrder asc, full details) returns the
 * first 100 of them with their token-balance changes. This file turns those transactions into the
 * ordered list of first buyers, with the token account each one bought into, so whether they
 * still hold is later one cheap getMultipleAccounts read of those accounts.
 *
 * Pure parsing, no IO - HeliusClient.getLaunchBuyersBatch does the fetching.
 */

export interface LaunchBuyer {
  wallet: string;
  /** The token account the buy landed in - what the still-holding check reads. */
  tokenAccount: string;
  /** Tokens bought across the transactions read, in base units. */
  bought: number;
}

export interface LaunchBuyersReading {
  /** The first buyers in order, the dev and the bonding curve aside. At most the requested count. */
  buyers: LaunchBuyer[];
  /** Block time of the create transaction. */
  launchAt: Date | null;
}

/** The parts of a getTransaction-shaped result this reads. Loose: providers vary the key shape. */
export interface RawLaunchTx {
  blockTime?: number | null;
  meta?: {
    err?: unknown;
    preTokenBalances?: RawTokenBalance[] | null;
    postTokenBalances?: RawTokenBalance[] | null;
    loadedAddresses?: { writable?: string[]; readonly?: string[] } | null;
  } | null;
  transaction?: {
    message?: { accountKeys?: (string | { pubkey?: string })[] };
  } | null;
}

interface RawTokenBalance {
  accountIndex: number;
  mint?: string;
  owner?: string;
  uiTokenAmount?: { amount?: string };
}

/**
 * The account keys a balance's accountIndex points into: the static keys, then (for a v0/v1
 * transaction in "json" encoding) the lookup-table addresses, writable before readonly.
 * jsonParsed already folds those into accountKeys as objects, with no loadedAddresses.
 */
function accountKeys(tx: RawLaunchTx): string[] {
  const keys = (tx.transaction?.message?.accountKeys ?? []).map((k) =>
    typeof k === "string" ? k : (k?.pubkey ?? ""),
  );
  const loaded = tx.meta?.loadedAddresses;
  if (loaded) keys.push(...(loaded.writable ?? []), ...(loaded.readonly ?? []));
  return keys;
}

/** Per owner, how this transaction moved their balance of `mint`, and the account it moved in. */
function balanceChanges(
  tx: RawLaunchTx,
  mint: string,
): { owners: Map<string, { delta: number; account: string }>; hadPre: boolean } {
  const keys = accountKeys(tx);
  const owners = new Map<string, { delta: number; account: string }>();
  const add = (b: RawTokenBalance, sign: 1 | -1) => {
    if (b.mint !== mint || !b.owner) return;
    const amount = Number(b.uiTokenAmount?.amount ?? 0);
    if (!Number.isFinite(amount)) return;
    const entry = owners.get(b.owner) ?? { delta: 0, account: keys[b.accountIndex] ?? "" };
    entry.delta += sign * amount;
    if (!entry.account) entry.account = keys[b.accountIndex] ?? "";
    owners.set(b.owner, entry);
  };
  const pre = (tx.meta?.preTokenBalances ?? []).filter((b) => b.mint === mint);
  for (const b of pre) add(b, -1);
  for (const b of tx.meta?.postTokenBalances ?? []) add(b, 1);
  return { owners, hadPre: pre.length > 0 };
}

/**
 * The first `maxBuyers` wallets to buy `mint`, from its earliest transactions in order.
 *
 * The first transaction must be the launch: it mints the supply, so no account held the mint
 * before it. Everyone it credits - the bonding curve, which takes the supply, and the dev, whose
 * initial buy rides in the create transaction - is excluded from the buyers for good, which also
 * keeps the curve from counting as a "buyer" each time someone sells into it. After that, any
 * other wallet whose balance goes up is a buyer, in the order it first did. Failed transactions
 * move no balances and are skipped.
 *
 * Returns null when the first transaction isn't a launch (an incomplete history), since the
 * order of buyers would then be wrong.
 */
export function parseLaunchBuyers(
  mint: string,
  txs: readonly RawLaunchTx[],
  maxBuyers: number,
): LaunchBuyersReading | null {
  const ok = txs.filter((tx) => tx && !tx.meta?.err && tx.meta);
  const create = ok[0];
  if (!create) return null;
  const launch = balanceChanges(create, mint);
  if (launch.hadPre || launch.owners.size === 0) return null;

  const excluded = new Set(launch.owners.keys());
  const buyers = new Map<string, LaunchBuyer>();
  for (const tx of ok.slice(1)) {
    for (const [owner, change] of balanceChanges(tx, mint).owners) {
      if (excluded.has(owner) || change.delta <= 0) continue;
      const known = buyers.get(owner);
      if (known) {
        known.bought += change.delta;
      } else if (buyers.size < maxBuyers && change.account) {
        buyers.set(owner, { wallet: owner, tokenAccount: change.account, bought: change.delta });
      }
    }
  }
  return {
    buyers: [...buyers.values()],
    launchAt: create.blockTime ? new Date(create.blockTime * 1000) : null,
  };
}

/** A buyer left holding under this share of what they bought counts as sold out (dust). */
export const LAUNCH_HOLDING_DUST_SHARE = 0.01;

/**
 * How many of `buyers` still hold, from their token accounts' current balances (base units; a
 * closed account is 0). Null when any balance is missing - a partial count would read low.
 */
export function countStillHolding(
  buyers: readonly LaunchBuyer[],
  balances: ReadonlyMap<string, number>,
): number | null {
  let holding = 0;
  for (const b of buyers) {
    const balance = balances.get(b.tokenAccount);
    if (balance === undefined) return null;
    if (balance > b.bought * LAUNCH_HOLDING_DUST_SHARE) holding += 1;
  }
  return holding;
}
