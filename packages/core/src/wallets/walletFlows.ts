import { isWalletAddress } from "../solana.js";
import { keysOf, type ChainTx } from "./tradeTape.js";

/**
 * A wallet's recent flows for Asyl (user ask 2026-10-24): who it sent SOL or coins to, who sent
 * them to it, and which coins it bought or sold, from a page of its own full transactions
 * (HeliusClient.getWalletTransactionsPage). The pure half; apps/api/src/asyl/chain.ts reads the
 * page, keeps the result in AsylFlowRead and draws it on the map. Shown only: nothing here feeds
 * the scan or the models.
 *
 * Each transaction is read from its balance changes alone, so any program's transfer counts the
 * same way:
 * - A trade: the wallet's balance of a coin moved one way and its SOL (wrapped SOL included) the
 *   other, by at least FLOW_MIN_SOL.
 * - A coin transfer: the wallet's balance of a coin moved and its SOL hardly did (rent for a new
 *   token account aside), and other wallets' balances of that coin moved the other way. Program
 *   accounts (pools, curves, vaults) are never counterparties: their addresses are off the curve.
 * - A SOL transfer: no coin moved for the wallet, its SOL moved by FLOW_MIN_SOL or more, and other
 *   wallets' SOL moved the other way.
 */

const WSOL_MINT = "So11111111111111111111111111111111111111112";
const LAMPORTS_PER_SOL = 1_000_000_000;
/** SOL moves under this are rent, fees or dust, not a payment. */
export const FLOW_MIN_SOL = 0.01;
/** Counterparties kept per transaction, largest first: a payout to hundreds is one airdrop. */
export const FLOW_MAX_COUNTERPARTIES = 12;
/** Counterparties and coins kept per read, by size. */
export const FLOW_MAX_EDGES = 120;
export const FLOW_MAX_TRADES = 80;

export interface WalletFlowTransfer {
  counterparty: string;
  /** "out": the wallet sent; "in": it received. */
  dir: "in" | "out";
  /** Null for SOL. */
  mint: string | null;
  /** SOL moved, or whole coins moved for a coin transfer. */
  amount: number;
  count: number;
  firstAt: number | null;
  lastAt: number | null;
}

export interface WalletFlowTrade {
  mint: string;
  buys: number;
  sells: number;
  solIn: number;
  solOut: number;
  firstAt: number | null;
  lastAt: number | null;
}

/**
 * Bridge programs on Solana mainnet (user ask 2026-10-26, "follow money through bridges"): a
 * transaction that calls one of these moved the wallet's money to or from another chain. Each
 * address checked against the bridge's own docs; Allbridge left out until its program is confirmed.
 */
export const BRIDGE_PROGRAMS: ReadonlyMap<string, string> = new Map([
  ["worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth", "Wormhole"],
  ["wormDTUJ6AWPNvk59vGQbDvGJmqbDTdgWgAqcLBCgUb", "Wormhole"],
  ["src5qyZHqTqecJV4aY6Cb6zDZLMDzrDKKezs22MPHr4", "deBridge"],
  ["dst5MGcFPoBeREFAA5E3tU5ij8m5uVYwkzkSAbsLbNo", "deBridge"],
  ["mayan34VedncxdK2XobtvWFDXQASUTBXhUVzt2kKgny", "Mayan"],
  ["BLZRi6frs4X4DNLw56V4EXai1b6QVESN1BhHBTYM9VcY", "Mayan"],
  ["CCTPiPYPc6AsJuwueEnWgSgucamXDZwBd53dQ11YiKX3", "Circle CCTP"],
  ["CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe", "Circle CCTP"],
]);
/** Bridge moves kept per read, newest first. */
export const FLOW_MAX_BRIDGES = 40;

export interface WalletFlowBridge {
  /** The bridge's name, and the program the transaction called. */
  bridge: string;
  program: string;
  /** "out": the wallet's money left Solana through it; "in": arrived. */
  dir: "in" | "out";
  /** Null for SOL. */
  mint: string | null;
  /** SOL moved, or whole coins moved. */
  amount: number;
  at: number | null;
  signature: string | null;
}

export interface WalletFlows {
  wallet: string;
  /** Transactions read. */
  txs: number;
  /** The oldest and newest of them (ms). */
  fromMs: number | null;
  toMs: number | null;
  transfers: WalletFlowTransfer[];
  trades: WalletFlowTrade[];
  /** Moves through a bridge. Absent on reads kept from before bridges were read. */
  bridges?: WalletFlowBridge[];
}

type Balance = NonNullable<NonNullable<ChainTx["meta"]>["preTokenBalances"]>[number] & {
  uiTokenAmount?: { amount?: string; decimals?: number };
};

/** Per owner, per mint, the change in whole coins. */
function tokenDeltas(tx: ChainTx): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  const add = (list: readonly Balance[] | null | undefined, sign: 1 | -1) => {
    for (const b of list ?? []) {
      if (!b.owner || !b.mint) continue;
      const raw = Number(b.uiTokenAmount?.amount ?? "0");
      const decimals = b.uiTokenAmount?.decimals ?? 0;
      if (!Number.isFinite(raw)) continue;
      const whole = raw / 10 ** decimals;
      let byMint = out.get(b.owner);
      if (!byMint) out.set(b.owner, (byMint = new Map()));
      byMint.set(b.mint, (byMint.get(b.mint) ?? 0) + sign * whole);
    }
  };
  add(tx.meta?.preTokenBalances as Balance[] | null | undefined, -1);
  add(tx.meta?.postTokenBalances as Balance[] | null | undefined, 1);
  return out;
}

/** Per account key, the change in SOL, with the fee given back to the payer (key 0). */
function solDeltas(tx: ChainTx, keys: readonly string[]): Map<string, number> {
  const pre = tx.meta?.preBalances ?? [];
  const post = tx.meta?.postBalances ?? [];
  const out = new Map<string, number>();
  keys.forEach((key, i) => {
    if (typeof pre[i] !== "number" || typeof post[i] !== "number") return;
    let delta = post[i]! - pre[i]!;
    if (i === 0) delta += tx.meta?.fee ?? 0;
    out.set(key, (out.get(key) ?? 0) + delta / LAMPORTS_PER_SOL);
  });
  return out;
}

/** The keys that are token accounts in this transaction: every account with a token balance. */
function tokenAccounts(tx: ChainTx, keys: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const list of [tx.meta?.preTokenBalances, tx.meta?.postTokenBalances]) {
    for (const b of (list ?? []) as { accountIndex?: number }[]) {
      const key = typeof b.accountIndex === "number" ? keys[b.accountIndex] : undefined;
      if (key) out.add(key);
    }
  }
  return out;
}

/**
 * SOL moves by wallet, not by account (user ask 2026-10-24: wallets on the map, never token
 * accounts): a token account's lamports are rent, or wrapped SOL that belongs to its owner. Token
 * accounts are dropped, and every other owner's wrapped-SOL change is counted as that owner's SOL
 * (the reading wallet's own is added where it is read, as mySol).
 */
function walletSol(
  sol: Map<string, number>,
  accounts: ReadonlySet<string>,
  tokens: Map<string, Map<string, number>>,
  wallet: string,
): Map<string, number> {
  const out = new Map([...sol].filter(([key]) => !accounts.has(key)));
  for (const [owner, byMint] of tokens) {
    const wsol = byMint.get(WSOL_MINT);
    if (owner === wallet || !wsol) continue;
    out.set(owner, (out.get(owner) ?? 0) + wsol);
  }
  return out;
}

/** The other side of a move: wallets whose balance went the opposite way, largest first. */
function counterparties(
  deltas: Iterable<[string, number]>,
  wallet: string,
  sign: number,
  min: number,
  walletCheck: (a: string) => boolean,
): [string, number][] {
  return [...deltas]
    .filter(([who, d]) => who !== wallet && Math.sign(d) === -sign && Math.abs(d) >= min && walletCheck(who))
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .slice(0, FLOW_MAX_COUNTERPARTIES)
    .map(([who, d]) => [who, Math.abs(d)]);
}

export function flowsFromTransactions(
  wallet: string,
  txs: readonly ChainTx[],
  walletCheck: (address: string) => boolean = isWalletAddress,
): WalletFlows {
  const isWallet = new Map<string, boolean>();
  const check = (a: string) => {
    let v = isWallet.get(a);
    if (v === undefined) isWallet.set(a, (v = walletCheck(a)));
    return v;
  };
  const transfers = new Map<string, WalletFlowTransfer>();
  const trades = new Map<string, WalletFlowTrade>();
  const bridges: WalletFlowBridge[] = [];
  let fromMs: number | null = null;
  let toMs: number | null = null;
  let read = 0;

  const addTransfer = (
    counterparty: string,
    dir: "in" | "out",
    mint: string | null,
    amount: number,
    at: number | null,
  ) => {
    const key = `${counterparty}|${dir}|${mint ?? ""}`;
    const row = transfers.get(key) ?? {
      counterparty,
      dir,
      mint,
      amount: 0,
      count: 0,
      firstAt: at,
      lastAt: at,
    };
    row.amount += amount;
    row.count += 1;
    if (at !== null) {
      row.firstAt = row.firstAt === null ? at : Math.min(row.firstAt, at);
      row.lastAt = row.lastAt === null ? at : Math.max(row.lastAt, at);
    }
    transfers.set(key, row);
  };

  for (const tx of txs) {
    if (tx.meta?.err) continue;
    read += 1;
    const at = typeof tx.blockTime === "number" ? tx.blockTime * 1000 : null;
    if (at !== null) {
      fromMs = fromMs === null ? at : Math.min(fromMs, at);
      toMs = toMs === null ? at : Math.max(toMs, at);
    }
    const keys = keysOf(tx);
    const tokens = tokenDeltas(tx);
    const sol = walletSol(solDeltas(tx, keys), tokenAccounts(tx, keys), tokens, wallet);
    const mine = tokens.get(wallet) ?? new Map<string, number>();
    // Wrapped SOL is SOL: a swap through the wallet's WSOL account moves it there instead.
    const mySol = (sol.get(wallet) ?? 0) + (mine.get(WSOL_MINT) ?? 0);
    const coins = [...mine].filter(([mint, d]) => mint !== WSOL_MINT && d !== 0);

    // A bridge call is the money leaving or reaching Solana, not a trade or a transfer here.
    const program = keys.find((k) => BRIDGE_PROGRAMS.has(k));
    if (program) {
      const coin = [...coins].sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))[0];
      if (coin || Math.abs(mySol) >= FLOW_MIN_SOL) {
        const d = coin ? coin[1] : mySol;
        bridges.push({
          bridge: BRIDGE_PROGRAMS.get(program)!,
          program,
          dir: d < 0 ? "out" : "in",
          mint: coin ? coin[0] : null,
          amount: Math.abs(d),
          at,
          signature: tx.transaction?.signatures?.[0] ?? null,
        });
      }
      continue;
    }

    if (coins.length > 0 && Math.abs(mySol) >= FLOW_MIN_SOL) {
      for (const [mint, d] of coins) {
        // A buy spends SOL for the coin, a sell the reverse; same-sign moves are something else.
        if (Math.sign(d) === Math.sign(mySol)) continue;
        const row = trades.get(mint) ?? {
          mint,
          buys: 0,
          sells: 0,
          solIn: 0,
          solOut: 0,
          firstAt: at,
          lastAt: at,
        };
        if (d > 0) {
          row.buys += 1;
          row.solIn += Math.abs(mySol) / coins.length;
        } else {
          row.sells += 1;
          row.solOut += Math.abs(mySol) / coins.length;
        }
        if (at !== null) {
          row.firstAt = row.firstAt === null ? at : Math.min(row.firstAt, at);
          row.lastAt = row.lastAt === null ? at : Math.max(row.lastAt, at);
        }
        trades.set(mint, row);
      }
      continue;
    }

    if (coins.length > 0) {
      for (const [mint, d] of coins) {
        const others: [string, number][] = [];
        for (const [owner, byMint] of tokens) {
          const od = byMint.get(mint);
          if (od !== undefined) others.push([owner, od]);
        }
        // Any program account's balance of the coin moving makes it a swap or a pool, not a transfer.
        if (others.some(([owner, od]) => owner !== wallet && od !== 0 && !check(owner))) continue;
        for (const [who, amount] of counterparties(others, wallet, Math.sign(d), Math.abs(d) * 0.01, check)) {
          addTransfer(who, d < 0 ? "out" : "in", mint, Math.min(amount, Math.abs(d)), at);
        }
      }
      continue;
    }

    if (Math.abs(mySol) >= FLOW_MIN_SOL) {
      for (const [who, amount] of counterparties(sol, wallet, Math.sign(mySol), FLOW_MIN_SOL, check)) {
        addTransfer(who, mySol < 0 ? "out" : "in", null, Math.min(amount, Math.abs(mySol)), at);
      }
    }
  }

  return {
    wallet,
    txs: read,
    fromMs,
    toMs,
    transfers: [...transfers.values()]
      // Most often first; SOL moves of the same count by size.
      .sort(
        (a, b) => b.count - a.count || (b.mint === null ? b.amount : 0) - (a.mint === null ? a.amount : 0),
      )
      .slice(0, FLOW_MAX_EDGES),
    trades: [...trades.values()]
      .sort((a, b) => b.solIn + b.solOut - (a.solIn + a.solOut))
      .slice(0, FLOW_MAX_TRADES),
    bridges: bridges.sort((a, b) => (b.at ?? 0) - (a.at ?? 0)).slice(0, FLOW_MAX_BRIDGES),
  };
}
