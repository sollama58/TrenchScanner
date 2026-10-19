import bs58 from "bs58";
import { PUMP_FUN_PROGRAM } from "../venueAccounts.js";

/**
 * One coin's trades read straight off a transaction's logs (user ask 2026-10-19: the token page's
 * live trades, as long as it doesn't add too much bandwidth). Pump.fun's bonding curve and PumpSwap
 * both log each swap as an Anchor event, a "Program data: <base64>" line whose first 8 bytes say
 * which event it is, carrying the trader, both sizes and the reserves the swap left. So a Helius
 * logsSubscribe on the coin's curve and pool (~6 KB a trade, nothing between trades) is the whole
 * feed: no transaction is fetched. apps/api/src/liveTrades.ts follows the coins being looked at.
 *
 * Layouts were decoded from mainnet transactions (2026-10-19) and checked against each one's
 * signer, balance changes and pool vaults; the test file holds those lines. An event is only taken
 * from its own program's frame of the log (the invoke/success lines around it), so another program
 * logging the same bytes in a transaction that merely mentions the curve isn't read as a trade.
 * One transaction can trade several coins (an aggregator's route): each event is checked against
 * the coin asked about, by mint on the curve and by pool on PumpSwap.
 */

const PUMP_SWAP_PROGRAM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
const DATA_PREFIX = "Program data: ";
const LAMPORTS_PER_SOL = 1e9;
/** Pump.fun coins (and so their PumpSwap pools' base side) have 6 decimals. */
const TOKEN_UNITS = 1e6;

/** Pump.fun's TradeEvent: sha256("event:TradeEvent")[0..8]. */
const CURVE_TRADE_DISCRIMINATOR = [189, 219, 127, 211, 78, 230, 97, 238];
/** After the discriminator: mint, sol_amount, token_amount, is_buy, user, timestamp, reserves. */
const CURVE_MINT_OFFSET = 8;
const CURVE_SOL_OFFSET = 40;
const CURVE_TOKENS_OFFSET = 48;
const CURVE_IS_BUY_OFFSET = 56;
const CURVE_USER_OFFSET = 57;
const CURVE_TIMESTAMP_OFFSET = 89;
/** The curve's virtual reserves after the trade (lamports, token base units). */
const CURVE_VIRTUAL_SOL_OFFSET = 97;
const CURVE_VIRTUAL_TOKEN_OFFSET = 105;
const CURVE_EVENT_BYTES = CURVE_VIRTUAL_TOKEN_OFFSET + 8;
/**
 * Coins on curves quoted in another coin (PUMP, USD1...; user report 2026-10-19: their trades all
 * read 0 SOL) log 0 in every SOL field and the trade in quote fields after the instruction's name,
 * a string whose length is at this offset. From the end of that name: the quote mint (all zeros
 * for SOL), the quote amount and the curve's virtual quote reserves after the trade.
 */
const CURVE_IX_NAME_OFFSET = 258;
const TAIL_QUOTE_MINT = 37;
const TAIL_QUOTE_AMOUNT = TAIL_QUOTE_MINT + 32;
const TAIL_QUOTE_RESERVE = TAIL_QUOTE_AMOUNT + 8;
/** The fee fields the quote amount is checked against: the protocol's basis points and amount. */
const CURVE_FEE_BPS_OFFSET = 161;
const CURVE_FEE_OFFSET = 169;

/** PumpSwap's BuyEvent and SellEvent. */
const POOL_BUY_DISCRIMINATOR = [103, 244, 82, 31, 44, 245, 119, 119];
const POOL_SELL_DISCRIMINATOR = [62, 47, 55, 10, 165, 3, 220, 42];
/**
 * Both open with 14 u64s, then the pool and the user. The fields read, by index: [0] timestamp;
 * [1] base amount out (buy) or in (sell); [5] and [6] the pool's base and quote reserves before
 * the swap; [7] quote amount in (buy) or out (sell); [12] what the quote vault took in (buy, with
 * the LP fee) or paid out (sell, without it); [13] the quote the user paid or received.
 */
const POOL_U64S_OFFSET = 8;
const POOL_POOL_OFFSET = POOL_U64S_OFFSET + 14 * 8;
const POOL_USER_OFFSET = POOL_POOL_OFFSET + 32;
const POOL_EVENT_BYTES = POOL_USER_OFFSET + 32;

export interface DecodedTrade {
  wallet: string;
  side: "buy" | "sell";
  /**
   * SOL the trade moved: on the curve its sol_amount; on PumpSwap what the user paid or got. Null
   * for a coin quoted in another coin: `quote` holds the trade, to be priced in SOL by the reader.
   */
  sol: number | null;
  /** Whole tokens. */
  tokens: number;
  /** The event's own clock (unix seconds, as ms). */
  atMs: number;
  /** SOL per whole token just after the trade, from the reserves it left; null if not derivable. */
  priceSol: number | null;
  /** A curve quoted in another coin: the trade in that coin's base units. */
  quote?: QuotedTrade;
  /**
   * A PumpSwap trade, in the pool's own base units: `sol` and `priceSol` read its quote as SOL and
   * leave out the pool's virtual quote reserve, which the reader adds (pumpSwapPool.ts) and, for a
   * pool quoted in another coin (PUMP), prices the quote in SOL with.
   */
  pool?: PoolTradeReserves;
}

export interface PoolTradeReserves {
  /** The quote the user paid or received, base units of the pool's quote coin. */
  amount: number;
  /** The quote vault after the trade, base units (the virtual reserve not included). */
  quoteReserve: number;
  /** The base vault after the trade, the coin's base units. */
  baseReserve: number;
}

export interface QuotedTrade {
  mint: string;
  /** What the trade moved, base units of the quote coin. */
  amount: number;
  /** The curve's virtual quote reserves after the trade, base units. */
  reserve: number;
  /** The curve's virtual token reserves after the trade, whole tokens. */
  tokenReserve: number;
}

export interface TradesFromLogsOptions {
  /** The coin: curve events for any other mint are skipped. */
  mint: string;
  /** Its PumpSwap pool (pumpSwapPoolOf): pool events are only read for this pool, none without it. */
  pool?: string | null;
}

/**
 * `mint`'s trades in one transaction's logs, in log order. Never throws: a line that doesn't decode
 * (garbage, a truncated log, an event layout this doesn't know) is skipped.
 */
export function tradesFromLogs(logs: readonly string[], opts: TradesFromLogsOptions): DecodedTrade[] {
  const out: DecodedTrade[] = [];
  if (!Array.isArray(logs)) return out;
  // The programs invoked, innermost last: an event is only trusted from its own program's frame.
  const frames: string[] = [];
  for (const line of logs) {
    if (typeof line !== "string") continue;
    const invoke = /^Program (\S+) invoke \[\d+\]$/.exec(line);
    if (invoke) {
      frames.push(invoke[1]!);
      continue;
    }
    const exit = /^Program (\S+) (?:success|failed)/.exec(line);
    if (exit) {
      if (frames[frames.length - 1] === exit[1]) frames.pop();
      continue;
    }
    if (!line.startsWith(DATA_PREFIX)) continue;
    const program = frames[frames.length - 1];
    if (program !== PUMP_FUN_PROGRAM && program !== PUMP_SWAP_PROGRAM) continue;
    try {
      const data = Buffer.from(line.slice(DATA_PREFIX.length), "base64");
      const trade =
        program === PUMP_FUN_PROGRAM ? curveTrade(data, opts.mint) : poolTrade(data, opts.pool ?? null);
      if (trade) out.push(trade);
    } catch {
      // Not an event this reads.
    }
  }
  return out;
}

function startsWith(data: Buffer, discriminator: readonly number[]): boolean {
  return discriminator.every((b, i) => data[i] === b);
}

const key = (data: Buffer, at: number) => bs58.encode(data.subarray(at, at + 32));
const u64 = (data: Buffer, at: number) => Number(data.readBigUInt64LE(at));

function curveTrade(data: Buffer, mint: string): DecodedTrade | null {
  if (data.length < CURVE_EVENT_BYTES || !startsWith(data, CURVE_TRADE_DISCRIMINATOR)) return null;
  if (key(data, CURVE_MINT_OFFSET) !== mint) return null;
  const isBuy = data[CURVE_IS_BUY_OFFSET];
  if (isBuy !== 0 && isBuy !== 1) return null;
  if (u64(data, CURVE_SOL_OFFSET) === 0) {
    // No SOL moved: a curve quoted in another coin, read from its quote fields; else nothing to show
    // (a 0 SOL trade is what every such trade read as before, user report 2026-10-19).
    const quote = quotedTrade(data);
    const at = Number(data.readBigInt64LE(CURVE_TIMESTAMP_OFFSET));
    if (!quote || !(at > 0)) return null;
    return {
      wallet: key(data, CURVE_USER_OFFSET),
      side: isBuy === 1 ? "buy" : "sell",
      sol: null,
      tokens: u64(data, CURVE_TOKENS_OFFSET) / TOKEN_UNITS,
      atMs: at * 1000,
      priceSol: null,
      quote,
    };
  }
  return trade(
    key(data, CURVE_USER_OFFSET),
    isBuy === 1 ? "buy" : "sell",
    u64(data, CURVE_SOL_OFFSET),
    u64(data, CURVE_TOKENS_OFFSET),
    Number(data.readBigInt64LE(CURVE_TIMESTAMP_OFFSET)),
    u64(data, CURVE_VIRTUAL_SOL_OFFSET),
    u64(data, CURVE_VIRTUAL_TOKEN_OFFSET),
  );
}

/**
 * The quote fields of a curve event whose SOL fields are 0, when the curve is quoted in another
 * coin; null otherwise (a SOL curve's 0-SOL trade, an older event without them). The amount is
 * only taken when the protocol fee logged beside it is that share of it, so a layout change reads
 * as no trade rather than a wrong one.
 */
function quotedTrade(data: Buffer): QuotedTrade | null {
  if (data.length < CURVE_IX_NAME_OFFSET + 4) return null;
  const tail = CURVE_IX_NAME_OFFSET + 4 + data.readUInt32LE(CURVE_IX_NAME_OFFSET);
  if (data.length < tail + TAIL_QUOTE_RESERVE + 8) return null;
  const mintBytes = data.subarray(tail + TAIL_QUOTE_MINT, tail + TAIL_QUOTE_AMOUNT);
  if (mintBytes.every((b) => b === 0)) return null;
  const amount = u64(data, tail + TAIL_QUOTE_AMOUNT);
  const bps = u64(data, CURVE_FEE_BPS_OFFSET);
  const fee = u64(data, CURVE_FEE_OFFSET);
  if (!(amount > 0)) return null;
  if (bps > 0 && Math.abs(fee - (amount * bps) / 10_000) > Math.max(2, fee * 0.02)) return null;
  const tokenReserve = u64(data, CURVE_VIRTUAL_TOKEN_OFFSET) / TOKEN_UNITS;
  return {
    mint: bs58.encode(mintBytes),
    amount,
    reserve: u64(data, tail + TAIL_QUOTE_RESERVE),
    tokenReserve,
  };
}

function poolTrade(data: Buffer, pool: string | null): DecodedTrade | null {
  if (pool === null || data.length < POOL_EVENT_BYTES) return null;
  const isBuy = startsWith(data, POOL_BUY_DISCRIMINATOR);
  if (!isBuy && !startsWith(data, POOL_SELL_DISCRIMINATOR)) return null;
  if (key(data, POOL_POOL_OFFSET) !== pool) return null;
  const field = (i: number) => u64(data, POOL_U64S_OFFSET + i * 8);
  const base = field(1);
  const vaulted = field(12);
  // A plain buy's user pays [13] (the quote plus every fee) and [7] is the quote before fees; a
  // buy_exact_quote_in's user pays exactly [7] and [13] comes out lower. The larger is what was
  // paid either way (checked against the signers' balances). A sell's user receives [13].
  const lamports = isBuy ? Math.max(field(7), field(13)) : field(13);
  // The event's reserves are from before the swap: moved by what the vaults took and gave.
  const baseAfter = isBuy ? field(5) - base : field(5) + base;
  const quoteAfter = isBuy ? field(6) + vaulted : field(6) - vaulted;
  const out = trade(
    key(data, POOL_USER_OFFSET),
    isBuy ? "buy" : "sell",
    lamports,
    base,
    field(0),
    quoteAfter,
    baseAfter,
  );
  return out && { ...out, pool: { amount: lamports, quoteReserve: quoteAfter, baseReserve: baseAfter } };
}

function trade(
  wallet: string,
  side: "buy" | "sell",
  lamports: number,
  baseUnits: number,
  timestampSec: number,
  quoteReserve: number,
  baseReserve: number,
): DecodedTrade | null {
  if (!Number.isFinite(timestampSec) || timestampSec <= 0) return null;
  return {
    wallet,
    side,
    sol: lamports / LAMPORTS_PER_SOL,
    tokens: baseUnits / TOKEN_UNITS,
    atMs: timestampSec * 1000,
    priceSol:
      quoteReserve > 0 && baseReserve > 0
        ? quoteReserve / LAMPORTS_PER_SOL / (baseReserve / TOKEN_UNITS)
        : null,
  };
}
