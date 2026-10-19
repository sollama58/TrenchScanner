import { prisma, createLogger, RISKY_WALLET_SCORE } from "@trenchscanner/core";
import { CHART_MARK_MIN_SOL } from "./feedAppearance.js";
import type { LiveTokenTrade } from "./liveTrades.js";

const logger = createLogger("chart-flagged-trades");

/**
 * Saves flagged wallets' trades as the live trades follower sees them (ChartFlaggedTrade, user ask
 * 2026-10-19): the trade tape reads only to 30 minutes past the call, so a KOL's, a labeled
 * wallet's or a risky wallet's later trade was marked on the token chart only while the chart was
 * open, and was gone the next time. Each SAVE_EVERY_MS the coins followed now are read for the
 * trades since the last pass, their traders checked against the flags in one batch, and the
 * flagged ones written (each once: a trade's signature, wallet and side are the key, so another
 * API instance saving the same trade is a no-op). The chart's wallet marks read them back
 * (routes/tokens.ts chartWallets). Nothing is read from the chain here: only coins someone has open.
 */

/** How often the followed coins' new trades are saved. */
export const SAVE_EVERY_MS = 10_000;
/** Traders checked against the flags at most a pass; the rest wait for the next. */
const MAX_WALLETS_PER_PASS = 2_000;

/** The followed coins and their kept trades (LiveTrades). */
export interface TradeSource {
  followedMints(): string[];
  recent(mint: string): Promise<{ trades: LiveTokenTrade[] } | null>;
}

/** One trade to save. */
export interface FlaggedTradeRow {
  sig: string;
  wallet: string;
  side: 1 | -1;
  mint: string;
  sol: number | null;
  at: Date;
}

export interface FlaggedTradeStore {
  /** Of `wallets`, those flagged anywhere, and each coin's creator among them by mint. */
  flagged(
    wallets: readonly string[],
    mints: readonly string[],
  ): Promise<{ wallets: Set<string>; creators: Map<string, string> }>;
  save(rows: readonly FlaggedTradeRow[]): Promise<void>;
}

/**
 * Exported for tests. The trades worth saving: of a size the chart can mark (or unpriced, which a
 * later price can't fix but the time still can), by a flagged wallet or the coin's creator.
 */
export function flaggedRows(
  byMint: ReadonlyMap<string, readonly Pick<LiveTokenTrade, "sig" | "wallet" | "side" | "sol" | "atMs">[]>,
  flagged: ReadonlySet<string>,
  creators: ReadonlyMap<string, string>,
): FlaggedTradeRow[] {
  const out: FlaggedTradeRow[] = [];
  for (const [mint, trades] of byMint) {
    for (const t of trades) {
      if (t.sol !== null && !(t.sol >= CHART_MARK_MIN_SOL)) continue;
      if (!flagged.has(t.wallet) && creators.get(mint) !== t.wallet) continue;
      out.push({
        sig: t.sig,
        wallet: t.wallet,
        side: t.side === "buy" ? 1 : -1,
        mint,
        sol: t.sol,
        at: new Date(t.atMs),
      });
    }
  }
  return out;
}

export class FlaggedTradeSaver {
  /** Each coin's last seq saved (the follower's seqs only grow within its process). */
  private readonly savedTo = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly source: TradeSource,
    private readonly store: FlaggedTradeStore,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.pass(), SAVE_EVERY_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One pass: the followed coins' trades since the last, the flagged ones saved. */
  async pass(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const mints = this.source.followedMints();
      for (const m of [...this.savedTo.keys()]) if (!mints.includes(m)) this.savedTo.delete(m);
      const byMint = new Map<string, LiveTokenTrade[]>();
      const upTo = new Map<string, number>();
      const wallets = new Set<string>();
      for (const mint of mints) {
        const recent = await this.source.recent(mint).catch(() => null);
        if (!recent) continue;
        const from = this.savedTo.get(mint) ?? 0;
        const fresh = recent.trades.filter((t) => t.seq > from);
        if (fresh.length === 0) continue;
        if (wallets.size + fresh.length > MAX_WALLETS_PER_PASS && wallets.size > 0) break;
        byMint.set(mint, fresh);
        upTo.set(mint, fresh[fresh.length - 1]!.seq);
        for (const t of fresh) wallets.add(t.wallet);
      }
      if (byMint.size === 0) return 0;
      const { wallets: flagged, creators } = await this.store.flagged([...wallets], [...byMint.keys()]);
      const rows = flaggedRows(byMint, flagged, creators);
      if (rows.length > 0) await this.store.save(rows);
      for (const [mint, seq] of upTo) this.savedTo.set(mint, seq);
      return rows.length;
    } catch (err) {
      // The trades stay kept a while: the next pass tries them again.
      logger.warn("flagged trades save failed", { error: String(err) });
      return 0;
    } finally {
      this.running = false;
    }
  }
}

/** The flags and the table, in the database. */
export const prismaFlaggedTradeStore: FlaggedTradeStore = {
  async flagged(wallets, mints) {
    const list = [...wallets];
    const [kols, labeled, risky, kolSides, labeledSides, funders, tokens] = await Promise.all([
      prisma.kolWallet.findMany({ where: { wallet: { in: list } }, select: { wallet: true } }),
      prisma.userTrackedWallet.findMany({ where: { wallet: { in: list } }, select: { wallet: true } }),
      prisma.walletRisk.findMany({
        where: {
          wallet: { in: list },
          OR: [{ score: { gte: RISKY_WALLET_SCORE } }, { dumper: true }, { winner: true }],
        },
        select: { wallet: true },
      }),
      prisma.kolPossibleSide.findMany({ where: { wallet: { in: list } }, select: { wallet: true } }),
      prisma.trackedWalletSide.findMany({ where: { wallet: { in: list } }, select: { wallet: true } }),
      prisma.walletFunder.findMany({
        where: { wallet: { in: list }, funder: { not: null } },
        select: { wallet: true, funder: true },
      }),
      prisma.token.findMany({
        where: { mintAddress: { in: [...mints] } },
        select: { mintAddress: true, creator: true },
      }),
    ]);
    const out = new Set([...kols, ...labeled, ...risky, ...kolSides, ...labeledSides].map((r) => r.wallet));
    // Funded by a KOL or a labeled wallet: a KOL Funded Wallet, or a labeled wallet's.
    const funderList = [...new Set(funders.map((f) => f.funder!))];
    if (funderList.length > 0) {
      const [kolFunders, labeledFunders] = await Promise.all([
        prisma.kolWallet.findMany({ where: { wallet: { in: funderList } }, select: { wallet: true } }),
        prisma.userTrackedWallet.findMany({
          where: { wallet: { in: funderList } },
          select: { wallet: true },
        }),
      ]);
      const paidBy = new Set([...kolFunders, ...labeledFunders].map((r) => r.wallet));
      for (const f of funders) if (paidBy.has(f.funder!)) out.add(f.wallet);
    }
    const creators = new Map(tokens.flatMap((t) => (t.creator ? [[t.mintAddress, t.creator] as const] : [])));
    return { wallets: out, creators };
  },
  async save(rows) {
    await prisma.chartFlaggedTrade.createMany({ data: [...rows], skipDuplicates: true });
  },
};
