import { prisma, createLogger, type CandidateToken, type HeliusClient } from "@trenchscanner/core";
import { FailureBackoff } from "./failureBackoff.js";

const logger = createLogger("quote-symbols");

/**
 * The ticker of the coin each candidate trades against, for the cards' quote pill (user report
 * 2026-10-19: some pills showed the quote's contract address). DexScreener's pair names its quote;
 * GeckoTerminal's gives only the mint, and those readings stored a quote with no ticker. Now a
 * candidate whose reading named no ticker gets one from, in order: the usual quotes below, a ticker
 * an earlier reading named, the quote coin's own Token row (most quotes are launches the scan
 * tracks), then its token metadata (Helius DAS getAssetBatch, one call for the cycle's misses).
 *
 * A quote still without a ticker is left off the candidate, so the row never stores a mint with no
 * name beside it: the next cycle tries again. A mint whose metadata has neither ticker nor name is
 * remembered as unnamed and never shown.
 *
 * Rate limits: one getAssetBatch per cycle at most, for quotes not yet named in this process, so a
 * few calls a day once the handful of quote coins in use are known; a failed call is backed off.
 */
const KNOWN_QUOTES: Readonly<Record<string, string>> = {
  So11111111111111111111111111111111111111112: "SOL",
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC",
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: "USDT",
  USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB: "USD1",
};

/** Tickers by quote mint; null = its metadata names nothing. Quote coins are few, so unbounded in practice. */
const named = new Map<string, string | null>();
const MAX_NAMED = 20_000;
const failureBackoff = new FailureBackoff();
/** Whether this process has named the quotes stored without a ticker before this fix. */
let backfilled = false;

/** Test hook: a fresh process's state. */
export function resetQuoteSymbolState(): void {
  named.clear();
  failureBackoff.clear();
  backfilled = false;
}

type SymbolReader = Pick<HeliusClient, "getTokenSymbolsBatch">;
type Db = {
  token: {
    findMany(args: {
      where: { mintAddress: { in: string[] } };
      select: { mintAddress: true; symbol: true };
    }): Promise<{ mintAddress: string; symbol: string | null }[]>;
  };
};

/** A base58 Solana address: what some sources put where a ticker belongs. */
const MINT_LIKE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** A usable ticker: trimmed, without a leading $, and not an address standing in for one. */
const clean = (s: string | null | undefined) => {
  const t = s?.trim().replace(/^\$/, "");
  return t && !MINT_LIKE.test(t) ? t : null;
};

function remember(mint: string, symbol: string | null): void {
  if (named.size >= MAX_NAMED) named.clear();
  named.set(mint, symbol);
}

/** Tickers for `mints`, from the sources above; a mint left out has none yet. */
export async function quoteSymbolsFor(
  mints: Iterable<string>,
  helius: SymbolReader,
  db: Db = prisma,
  now = Date.now(),
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const misses: string[] = [];
  for (const mint of new Set(mints)) {
    const known = KNOWN_QUOTES[mint] ?? named.get(mint);
    if (known) out.set(mint, known);
    else if (known === undefined) misses.push(mint);
  }
  if (misses.length === 0) return out;

  const rows = await db.token
    .findMany({ where: { mintAddress: { in: misses } }, select: { mintAddress: true, symbol: true } })
    .catch(() => []);
  for (const row of rows) {
    const symbol = clean(row.symbol);
    if (!symbol) continue;
    out.set(row.mintAddress, symbol);
    remember(row.mintAddress, symbol);
  }

  const ask = misses.filter((m) => !out.has(m) && !failureBackoff.blocked(m, now));
  if (ask.length === 0) return out;
  const read = await helius.getTokenSymbolsBatch(ask).catch(() => "failed" as const);
  if (read === "failed") {
    for (const m of ask) failureBackoff.fail(m, now);
    logger.warn("quote ticker lookup failed", { mints: ask.length });
    return out;
  }
  for (const m of ask) {
    const meta = read.get(m);
    const symbol = clean(meta?.symbol) ?? clean(meta?.name);
    failureBackoff.succeed(m);
    remember(m, symbol);
    if (symbol) out.set(m, symbol);
  }
  return out;
}

/**
 * Fills in each candidate's quote ticker where its reading named none (in place), and drops a
 * quote that still has none - see above. A ticker a reading did name is remembered for the next.
 */
export async function resolveQuoteSymbols(
  candidates: CandidateToken[],
  helius: SymbolReader,
  db: Db = prisma,
): Promise<void> {
  const needs: CandidateToken[] = [];
  for (const c of candidates) {
    if (!c.quoteMint) continue;
    const own = clean(c.quoteSymbol);
    if (own) {
      c.quoteSymbol = own;
      if (named.get(c.quoteMint) !== own) remember(c.quoteMint, own);
    } else needs.push(c);
  }
  if (needs.length === 0) return;
  const symbols = await quoteSymbolsFor(
    needs.map((c) => c.quoteMint!),
    helius,
    db,
  );
  for (const c of needs) {
    const symbol = symbols.get(c.quoteMint!);
    if (symbol) c.quoteSymbol = symbol;
    else c.quoteMint = undefined;
  }
}

/**
 * Names the quotes rows already store without a ticker (written by GeckoTerminal readings before
 * this fix, or with an address for a ticker), once per process: one read of the rows needing it, then an update per ticker by mint
 * address. A run that couldn't name every quote leaves the rest for the next cycle. Few rows need
 * it (a day of GeckoTerminal-priced non-SOL pairs), so the read is small.
 */
export async function backfillQuoteSymbols(helius: SymbolReader): Promise<number> {
  if (backfilled) return 0;
  // No ticker, or an address where the ticker belongs.
  const rows = await prisma.$queryRaw<{ mintAddress: string; quoteMint: string }[]>`
    SELECT "mintAddress", "quoteMint" FROM "Token"
    WHERE "quoteMint" IS NOT NULL
      AND ("quoteSymbol" IS NULL OR "quoteSymbol" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$')
    LIMIT 5000`;
  if (rows.length === 0) {
    backfilled = true;
    return 0;
  }
  const symbols = await quoteSymbolsFor(
    rows.map((r) => r.quoteMint),
    helius,
  );
  const byTicker = new Map<string, string[]>();
  for (const r of rows) {
    const symbol = symbols.get(r.quoteMint);
    if (symbol) byTicker.set(symbol, [...(byTicker.get(symbol) ?? []), r.mintAddress]);
  }
  let updated = 0;
  for (const [symbol, mints] of byTicker) {
    const res = await prisma.token.updateMany({
      where: { mintAddress: { in: mints } },
      data: { quoteSymbol: symbol },
    });
    updated += res.count;
  }
  // Done once every quote got an answer (a ticker, or metadata naming nothing); a failed lookup
  // or a full page leaves the rest for the next cycle.
  const answered = rows.every((r) => symbols.has(r.quoteMint) || named.has(r.quoteMint));
  if (answered && rows.length < 5_000) backfilled = true;
  logger.info("named stored quotes", { rows: rows.length, updated });
  return updated;
}
