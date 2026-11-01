import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { createLogger } from "../logger.js";
import { escapeHtml } from "../telegram/format.js";
import { solToLamports } from "../trading/config.js";
import { lossWindowStart, mintRisk, netLoss, positionMultiple } from "../trading/engine.js";
import { sellAmount } from "../trading/exitEngine.js";
import { NoRouteError, RateLimitedError, WSOL_MINT, type SwapClient } from "../trading/jupiterSwap.js";
import { paperSwapFee, penalizedFill } from "../trading/paper.js";
import type { MintInfo } from "../trading/rpc.js";
import type { TradeAlertEvent } from "../trading/tradeAlerts.js";
import { signedSol, solAmount, tokenLink, type TradeNote } from "../trading/tradeNotes.js";
import { decideAdaptiveExit, type FdsaExitReason } from "./adaptiveExit.js";
import {
  DEFAULT_FDSA_BANKROLL_SOL,
  DEFAULT_FDSA_DESK_CONFIG,
  FDSA_DESK_ID,
  readFdsaDeskConfig,
  readFdsaMode,
  type FdsaDeskConfig,
  type FdsaExecutor,
  type FdsaFillResult,
} from "./desk.js";
import {
  applyFdsaRevision,
  FDSA_HARD_FLOOR_MULTIPLE,
  FDSA_MAX_HOLD_CAP_MINUTES,
  fdsaFloorMultiple,
  fdsaRevisionDue,
  readFdsaExitPlan,
  readFdsaExitPlanOrHardFloor,
  type FdsaExitPlan,
  type FdsaRevisionOptions,
  type FdsaRevisionTrigger,
} from "./exitPlan.js";
import type { FdsaTapePoint } from "./prompts.js";
import type { FdsaRead, FdsaReviseVerdict } from "./verdicts.js";

/**
 * The FDSA paper desk (owner decision 2026-10-31; Thread C of the FDSA build, 2026-11-01): one
 * pass, run inside the scanner's paper-trading job every 10 s, that
 *   1. walks every open FDSA position through its adaptive exit plan (decideAdaptiveExit) on a
 *      fresh price, sells through the executor, and books the fill;
 *   2. at the plan's named triggers (crossing 2x, crossing 4x, a drop from the high, a timer)
 *      asks the reviser for a new plan - detached, never in the per-tick path, so a slow or failed
 *      Claude call leaves the last good plan running and the next tick still exits;
 *   3. stops the desk at the daily loss limit, as the bot does;
 *   4. buys the decide stage's fresh "trade" verdicts (FdsaReview rows) at the desk's fixed size,
 *      under the same guards the paper strategies and the bot apply: signal freshness
 *      (maxSignalAgeSeconds), one entry per mint, the open-position cap, the 24 h spend, the
 *      reserve, and mintRisk.
 *
 * Paper only (decision 6). Every fill goes through an FdsaExecutor; paperFdsaExecutor below fills
 * from live Jupiter quotes less the fill penalty and fees, as trading/paper.ts does. Nothing here
 * holds a key, builds a transaction or signs (fdsa.test.ts checks the imports). A later Live PR
 * hands this pass an executor on the bot engine's swap path and nothing else here changes.
 *
 * FDSA positions are FdsaPosition rows on the FdsaDesk bankroll, never PaperPosition or
 * TradingPosition, so their stats never mix with the admin's own strategies or bot.
 */

const logger = createLogger("fdsa-desk");

/** Positions walked per pass, and the pass's time budget (as paper.ts). */
const MAX_POSITIONS_PER_PASS = 100;
const PASS_BUDGET_MS = 45_000;
/** Trade verdicts read per pass: far more than the open-position cap lets it buy. */
const MAX_INTENTS_PER_PASS = 50;
/**
 * FDSA's notes go to every admin's private chats (decision 10: "the same way the bot's do"). The
 * desk has no owning user, so its notes carry this id and the worker sends them with it as the
 * server user (tradeNotes.ts sendTradeNotes serverUserId), which addresses all admins.
 */
export const FDSA_NOTE_USER_ID = "fdsa-desk";

// ── The paper executor ───────────────────────────────────────────────────────────────────────

export interface FdsaPaperExecutorDeps {
  swap: Pick<SwapClient, "quote">;
  rpc: { getMintInfo(mint: string): Promise<MintInfo | null> };
}

/**
 * Fills at a live Jupiter quote less the desk's fill penalty, and charges each swap the network
 * fee plus the Jito tip (or the priority fee with no tip): paper.ts's arithmetic, so FDSA's paper
 * record reads like a strategy's. "No route" is a fill that didn't happen, retried next pass; a
 * rate limit is thrown so the pass stops asking.
 */
export function paperFdsaExecutor(deps: FdsaPaperExecutorDeps): FdsaExecutor {
  return {
    mode: "paper",
    async buy(order) {
      const mint = await deps.rpc.getMintInfo(order.mint).catch(() => null);
      if (!mint || mint.decimals === undefined)
        return { ok: false, error: "mint unreadable", retryable: false };
      return quoteFill(
        deps,
        { inputMint: WSOL_MINT, outputMint: order.mint, amount: order.lamports },
        order.config.slippageBps,
        order.config,
        (out) => ({ lamports: order.lamports, tokens: out, decimals: mint.decimals! }),
      );
    },
    async sell(order) {
      const slippage = order.protective
        ? Math.max(order.config.slippageBps, order.config.exitSlippageBps)
        : order.config.slippageBps;
      return quoteFill(
        deps,
        { inputMint: order.mint, outputMint: WSOL_MINT, amount: order.tokens },
        slippage,
        order.config,
        (out) => ({ lamports: out, tokens: order.tokens, decimals: order.decimals }),
      );
    },
  };
}

async function quoteFill(
  deps: FdsaPaperExecutorDeps,
  input: { inputMint: string; outputMint: string; amount: bigint },
  slippageBps: number,
  config: FdsaDeskConfig,
  fill: (penalizedOut: bigint) => { lamports: bigint; tokens: bigint; decimals: number },
): Promise<FdsaFillResult> {
  let out: bigint;
  try {
    const quote = await deps.swap.quote({ ...input, slippageBps });
    out = penalizedFill(BigInt(quote.outAmount), config.fillPenaltyBps);
  } catch (err) {
    if (err instanceof NoRouteError) return { ok: false, error: "no route", retryable: true };
    throw err;
  }
  if (out <= 0n) return { ok: false, error: "the quote fills nothing", retryable: true };
  return { ok: true, feeLamports: paperSwapFee(config), ...fill(out) };
}

// ── The reviser seam ─────────────────────────────────────────────────────────────────────────

/** What a revision call is given: the position as the trigger found it. */
export interface FdsaRevisionRequest {
  positionId: string;
  tokenId: string | null;
  mint: string;
  symbol: string | null;
  trigger: FdsaRevisionTrigger;
  multiple: number;
  peakMultiple: number | null;
  floorMultiple: number;
  soldFraction: number;
  plan: FdsaExitPlan;
  planVersion: number;
  openedAt: Date;
  /**
   * The desk's own readings of the multiple over the hold, oldest first (fdsaPositionTape): what
   * the reviser reads the move off, since no price feed carries a position's own path (AI
   * evaluation 2026-11-01).
   */
  tape: FdsaTapePoint[];
  /**
   * The fill's price in USD at today's SOL price - the desk doesn't store the SOL price at entry,
   * and SOL moves little over a hold. Null when no SOL price was in hand. The reviser sets it
   * against the alert's anchor (FdsaReview.anchorPriceUsd) so the model knows where the alert's
   * 2x sits in entry multiples.
   */
  entryPriceUsd: number | null;
  at: Date;
}

/**
 * The call that asks Claude for a new plan (the review pipeline's revise stage, which reserves
 * from FDSA's exit slice of the budget and stores its FdsaReview). `ok: false` is a call that
 * failed, timed out or found no budget; the running plan stays either way.
 */
export type FdsaRevisionResult =
  | { ok: true; reviewId: string | null; read: FdsaRead<FdsaReviseVerdict> }
  | { ok: false; reviewId?: string | null; error: string };

export interface FdsaReviser {
  revise(request: FdsaRevisionRequest): Promise<FdsaRevisionResult>;
}

// ── The pass ─────────────────────────────────────────────────────────────────────────────────

export interface FdsaDeskDeps {
  /** Prices for the per-tick multiple, and the quote fallback when there is no price. */
  market: Pick<SwapClient, "quote" | "pricesUsd">;
  rpc: { getMintInfo(mint: string): Promise<MintInfo | null> };
  /** Where fills go: paperFdsaExecutor today. Its mode must match the desk's. */
  executor: FdsaExecutor;
  /** Buys new trade verdicts. False (FDSA_ENABLED off) still runs exits on open positions. */
  entries: boolean;
  /** Plan revisions at triggers; omitted, plans run as set at entry. */
  reviser?: FdsaReviser;
  revision: FdsaRevisionOptions;
  now?: () => Date;
  /** Delivers the pass's Telegram notes at its end; omitted sends none. */
  notify?: (notes: TradeNote[]) => Promise<void>;
  /**
   * Takes each detached revision call. The worker leaves it unset (fire and forget, each call
   * handles its own failure); tests collect the promises to await them.
   */
  dispatch?: (revision: Promise<void>) => void;
}

export interface FdsaDeskSkip {
  reviewId: string;
  mint: string;
  why: string;
}

export interface FdsaDeskSummary {
  running: boolean;
  open: number;
  exitsChecked: number;
  sells: number;
  revisionsDispatched: number;
  intents: number;
  entries: number;
  skips: FdsaDeskSkip[];
  errors: number;
}

/** The desk row, created on first use with the paper defaults (decision 4) and not running. */
export async function ensureFdsaDesk() {
  const bankroll = solToLamports(DEFAULT_FDSA_BANKROLL_SOL);
  return prisma.fdsaDesk.upsert({
    where: { id: FDSA_DESK_ID },
    create: {
      id: FDSA_DESK_ID,
      mode: "paper",
      running: false,
      config: DEFAULT_FDSA_DESK_CONFIG as unknown as Prisma.InputJsonValue,
      bankrollLamports: bankroll,
      cashLamports: bankroll,
    },
    update: {},
  });
}

/** A pass's cash change found the desk reset under it: dropped with the rest of the change. */
class ResetUnderUs extends Error {}
/** Another pass sold this holding first (a deploy runs two scanners side by side). */
class SoldUnderUs extends Error {}

/** Revisions in flight in this process, so one position never has two calls out at once. */
const inFlight = new Set<string>();

export async function runFdsaDesk(deps: FdsaDeskDeps): Promise<FdsaDeskSummary> {
  const now = () => deps.now?.() ?? new Date();
  const started = Date.now();
  const inBudget = () => Date.now() - started < PASS_BUDGET_MS;
  const notes: TradeNote[] = [];
  const summary: FdsaDeskSummary = {
    running: false,
    open: 0,
    exitsChecked: 0,
    sells: 0,
    revisionsDispatched: 0,
    intents: 0,
    entries: 0,
    skips: [],
    errors: 0,
  };
  // With FDSA off and no desk yet there is nothing to exit and nothing to buy: no row is created.
  const desk = deps.entries
    ? await ensureFdsaDesk()
    : await prisma.fdsaDesk.findUnique({ where: { id: FDSA_DESK_ID } });
  if (!desk) return summary;
  const config = readFdsaDeskConfig(desk.config);
  if (deps.executor.mode !== readFdsaMode(desk.mode)) {
    // A Live executor handed to a paper desk (or the reverse) never trades: it would book one
    // mode's fills on the other's bankroll.
    throw new Error(`FDSA executor is ${deps.executor.mode}, the desk is ${readFdsaMode(desk.mode)}`);
  }
  try {
    await manageExits(deps, desk, config, summary, now, inBudget, notes);
    let running = desk.running;
    if (running && (await pausedForLoss(desk, config, now(), notes))) running = false;
    summary.running = running;
    if (running && deps.entries && inBudget()) {
      await openEntries(deps, desk, config, summary, now, inBudget, notes);
      await prisma.fdsaDesk.update({
        where: { id: desk.id },
        data: { lastRunAt: now(), lastError: null },
      });
    }
  } catch (err) {
    summary.errors++;
    await prisma.fdsaDesk
      .update({ where: { id: desk.id }, data: { lastRunAt: now(), lastError: errText(err) } })
      .catch(() => undefined);
    logger.warn("fdsa desk pass failed", { error: errText(err) });
  } finally {
    summary.open = await prisma.fdsaPosition
      .count({ where: { deskId: desk.id, status: "open" } })
      .catch(() => summary.open);
    if (deps.notify && notes.length > 0 && config.notifyTelegram) {
      await deps.notify(notes).catch((err) => logger.warn("fdsa notes failed", { error: errText(err) }));
    }
  }
  return summary;
}

type DeskRow = Prisma.FdsaDeskGetPayload<object>;
type PositionRow = Prisma.FdsaPositionGetPayload<object>;

function note(notes: TradeNote[], event: TradeAlertEvent, html: string) {
  notes.push({ userId: FDSA_NOTE_USER_ID, html: `🤖 <b>FDSA · Paper</b>: ${html}`, source: "paper", event });
}

const EXIT_TEXT: Record<FdsaExitReason, string> = {
  stop_loss: "stop loss",
  floor: "profit floor",
  partial: "partial take",
  stall: "stalled",
  max_hold: "time limit",
  manual: "sold on request",
};

/** The trade-alert setting a sale is filed under (tradeAlerts.ts). */
function saleEventOf(reason: FdsaExitReason): TradeAlertEvent {
  switch (reason) {
    case "partial":
      return "take_profit";
    case "floor":
      return "trailing_stop";
    case "stall":
    case "max_hold":
      return "time_limit";
    case "manual":
      return "manual";
    default:
      return "stop_loss";
  }
}

// ── Exits ────────────────────────────────────────────────────────────────────────────────────

async function manageExits(
  deps: FdsaDeskDeps,
  desk: DeskRow,
  config: FdsaDeskConfig,
  summary: FdsaDeskSummary,
  now: () => Date,
  inBudget: () => boolean,
  notes: TradeNote[],
) {
  const open = await prisma.fdsaPosition.findMany({
    where: { deskId: desk.id, status: "open" },
    orderBy: { openedAt: "asc" },
    take: MAX_POSITIONS_PER_PASS,
  });
  if (open.length === 0) return;
  let prices = new Map<string, number>();
  try {
    prices = await deps.market.pricesUsd([...new Set(open.map((p) => p.mint)), WSOL_MINT]);
  } catch (err) {
    logger.warn("price lookup failed; pricing by quotes", { error: errText(err) });
  }
  const solUsd = prices.get(WSOL_MINT);
  for (const position of open) {
    if (!inBudget()) return;
    summary.exitsChecked++;
    try {
      if (
        await manageExit(
          deps,
          desk,
          config,
          position,
          prices.get(position.mint),
          solUsd,
          now(),
          summary,
          notes,
        )
      )
        summary.sells++;
    } catch (err) {
      if (err instanceof SoldUnderUs) continue;
      summary.errors++;
      if (err instanceof ResetUnderUs) continue;
      await prisma.fdsaPosition
        .update({ where: { id: position.id }, data: { error: errText(err) } })
        .catch(() => undefined);
      if (err instanceof RateLimitedError) return;
    }
  }
}

/** One position's tick: price, decide, sell if due, or ask for a revision if one is due. True when it sold. */
async function manageExit(
  deps: FdsaDeskDeps,
  desk: DeskRow,
  config: FdsaDeskConfig,
  position: PositionRow,
  tokenUsd: number | undefined,
  solUsd: number | undefined,
  now: Date,
  summary: FdsaDeskSummary,
  notes: TradeNote[],
): Promise<boolean> {
  const plan = readFdsaExitPlanOrHardFloor(position.exitPlan);
  const bought = BigInt(position.tokensBought);
  const held = BigInt(position.tokensHeld);
  if (held <= 0n) {
    await prisma.fdsaPosition.update({
      where: { id: position.id },
      data: { status: "closed", closedAt: now, closeReason: position.closeReason ?? "empty" },
    });
    tapes.delete(position.id);
    return false;
  }

  let reason: FdsaExitReason;
  let fraction: number;
  let all: boolean;
  let multiple: number | null = null;
  if (position.closeRequested) {
    reason = "manual";
    fraction = 1;
    all = true;
  } else {
    multiple = positionMultiple(position, tokenUsd, solUsd);
    if (multiple === null) multiple = await quotedMultiple(deps, position, held, bought);
    if (multiple === null) {
      const ageMinutes = (now.getTime() - position.openedAt.getTime()) / 60_000;
      if (ageMinutes < Math.min(plan.maxHoldMinutes, FDSA_MAX_HOLD_CAP_MINUTES)) {
        await prisma.fdsaPosition.update({
          where: { id: position.id },
          data: { error: "no price for the token right now" },
        });
        return false;
      }
      reason = "max_hold";
      fraction = 1;
      all = true;
    } else {
      const d = decideAdaptiveExit(
        {
          openedAt: position.openedAt,
          peakMultiple: position.peakMultiple,
          floorMultiple: position.floorMultiple,
          soldFraction: position.soldFraction,
        },
        multiple,
        now,
        plan,
      );
      const peak = d.peakMultiple;
      const floor = d.floorMultiple;
      // The peak is a fact and the floor only ratchets up, so both are stored on every tick, sale
      // or not: a sale that fails to fill is decided again next tick against the same floor.
      await prisma.fdsaPosition.update({
        where: { id: position.id },
        data: {
          lastMultiple: multiple,
          lastPricedAt: now,
          peakMultiple: peak,
          floorMultiple: floor,
          error: null,
        },
      });
      recordTape(position.id, now, multiple);
      if (d.action === "hold") {
        maybeRevise(deps, position, plan, multiple, peak, floor, now, solUsd, summary);
        return false;
      }
      reason = d.reason;
      fraction = d.fraction;
      all = d.all;
    }
  }

  const amount = sellAmount({ fraction, all }, bought, held);
  if (amount <= 0n) return false;
  const fill = await deps.executor.sell({
    mint: position.mint,
    tokens: amount,
    decimals: position.decimals,
    protective: reason !== "partial",
    config,
  });
  if (!fill.ok) {
    await prisma.fdsaPosition.update({
      where: { id: position.id },
      data: { error: `${fill.error} (${reason})` },
    });
    return false;
  }
  const net = fill.lamports > fill.feeLamports ? fill.lamports - fill.feeLamports : 0n;
  const left = held - amount;
  const soldFraction = bought > 0n ? Math.min(1, Math.max(0, 1 - Number(left) / Number(bought))) : 1;
  await prisma.$transaction(async (tx) => {
    // A claim on the holding as this pass read it, as paper.ts claims: two scanners side by side
    // during a deploy must not both book the same sale.
    const claimed = await tx.fdsaPosition.updateMany({
      where: { id: position.id, status: "open", tokensHeld: position.tokensHeld },
      data: {
        tokensHeld: left.toString(),
        proceedsLamports: { increment: net },
        soldFraction,
        ...(reason === "partial" ? { partialsTaken: { increment: 1 } } : {}),
        ...(left <= 0n ? { status: "closed", closedAt: now, closeReason: reason } : {}),
        error: null,
      },
    });
    if (claimed.count !== 1) throw new SoldUnderUs("position sold by another pass");
    await tx.fdsaFill.create({
      data: {
        positionId: position.id,
        side: "sell",
        reason,
        planVersion: position.planVersion,
        lamports: fill.lamports,
        feeLamports: fill.feeLamports,
        tokens: amount.toString(),
        multiple,
      },
    });
    const credited = await tx.fdsaDesk.updateMany({
      where: { id: desk.id, resetAt: desk.resetAt },
      data: { cashLamports: { increment: net } },
    });
    if (credited.count === 0) throw new ResetUnderUs("desk reset during the pass");
  });
  if (left <= 0n) tapes.delete(position.id);
  const result =
    left <= 0n
      ? `; closed ${signedSol(position.proceedsLamports + net - position.swapInLamports - position.feesLamports)}`
      : "";
  const at = multiple !== null ? ` at ${multiple.toFixed(2)}x` : "";
  note(
    notes,
    saleEventOf(reason),
    `sold ${tokenLink(position.symbol, position.mint)} (${EXIT_TEXT[reason]}${at}), ${solAmount(net)} back${result}`,
  );
  return true;
}

/** The multiple from a sell quote for what is held, when the price sources have none (as paper.ts). */
async function quotedMultiple(
  deps: FdsaDeskDeps,
  position: PositionRow,
  held: bigint,
  bought: bigint,
): Promise<number | null> {
  if (bought <= 0n) return null;
  try {
    const quote = await deps.market.quote({
      inputMint: position.mint,
      outputMint: WSOL_MINT,
      amount: held,
      slippageBps: 5000,
    });
    const costOfHeld = (Number(position.swapInLamports) * Number(held)) / Number(bought);
    return costOfHeld > 0 ? Number(quote.outAmount) / costOfHeld : null;
  } catch (err) {
    if (err instanceof RateLimitedError) throw err;
    return null;
  }
}

// ── The position tape ────────────────────────────────────────────────────────────────────────

/**
 * Each open position's own readings of its multiple, one per tick, in this process's memory (AI
 * evaluation 2026-11-01). The revise brief reads the move off it: no price feed carries a
 * position's path from its own fill, and the row keeps only the last and peak multiples. Kept to
 * the hold cap at one reading a tick (TAPE_MAX_POINTS), dropped when the position closes. A
 * restart starts the tape over, and the brief then says it covers only the minutes since; the
 * exits themselves never read it.
 */
const TAPE_MAX_POINTS = 2_000;
const tapes = new Map<string, { at: number; multiple: number }[]>();

function recordTape(positionId: string, at: Date, multiple: number): void {
  if (!Number.isFinite(multiple) || multiple <= 0) return;
  let tape = tapes.get(positionId);
  if (!tape) {
    tape = [];
    tapes.set(positionId, tape);
  }
  const last = tape.at(-1);
  if (last && at.getTime() <= last.at) return;
  tape.push({ at: at.getTime(), multiple });
  if (tape.length > TAPE_MAX_POINTS) tape.splice(0, tape.length - TAPE_MAX_POINTS);
}

/** A position's tape as the revise brief takes it: minutes before `now`, oldest first. */
export function fdsaPositionTape(positionId: string, now: Date): FdsaTapePoint[] {
  return (tapes.get(positionId) ?? []).map((p) => ({
    minutesAgo: (now.getTime() - p.at) / 60_000,
    multiple: p.multiple,
  }));
}

/** Test hook: forgets every tape. */
export function resetFdsaPositionTapes(): void {
  tapes.clear();
}

/** The fill's price in USD at the given SOL price (see FdsaRevisionRequest.entryPriceUsd). */
export function fdsaEntryPriceUsd(
  position: Pick<PositionRow, "swapInLamports" | "tokensBought" | "decimals">,
  solUsd: number | undefined,
): number | null {
  if (!solUsd || !Number.isFinite(solUsd) || solUsd <= 0) return null;
  const tokens = Number(position.tokensBought) / 10 ** position.decimals;
  const sol = Number(position.swapInLamports) / 1e9;
  if (!(tokens > 0) || !(sol > 0)) return null;
  return (sol / tokens) * solUsd;
}

// ── Revisions ────────────────────────────────────────────────────────────────────────────────

/**
 * Asks for a revision when one is due (fdsaRevisionDue), without waiting for it. The trigger is
 * claimed first - lastRevisionAt and the fired marks written under the value this pass read - so
 * two scanners never ask twice, and the rate limit counts from the ask whatever its outcome.
 */
function maybeRevise(
  deps: FdsaDeskDeps,
  position: PositionRow,
  plan: FdsaExitPlan,
  multiple: number,
  peak: number | null,
  floor: number,
  now: Date,
  solUsd: number | undefined,
  summary: FdsaDeskSummary,
) {
  const reviser = deps.reviser;
  if (!reviser || inFlight.has(position.id)) return;
  const due = fdsaRevisionDue(
    {
      openedAt: position.openedAt,
      peakMultiple: peak,
      triggersFired: position.triggersFired,
      lastRevisionAt: position.lastRevisionAt,
    },
    multiple,
    now,
    deps.revision,
  );
  if (!due) return;
  const request: FdsaRevisionRequest = {
    positionId: position.id,
    tokenId: position.tokenId,
    mint: position.mint,
    symbol: position.symbol,
    trigger: due.trigger,
    multiple,
    peakMultiple: peak,
    floorMultiple: floor,
    soldFraction: position.soldFraction,
    plan,
    planVersion: position.planVersion,
    openedAt: position.openedAt,
    tape: fdsaPositionTape(position.id, now),
    entryPriceUsd: fdsaEntryPriceUsd(position, solUsd),
    at: now,
  };
  inFlight.add(position.id);
  summary.revisionsDispatched++;
  const run = (async () => {
    try {
      const claimed = await prisma.fdsaPosition.updateMany({
        where: { id: position.id, status: "open", lastRevisionAt: position.lastRevisionAt },
        data: {
          lastRevisionAt: now,
          ...(due.marks.length > 0 ? { triggersFired: { push: due.marks } } : {}),
        },
      });
      if (claimed.count !== 1) return;
      await reviseAndApply(reviser, request);
    } catch (err) {
      logger.warn("fdsa revision failed", { positionId: position.id, error: errText(err) });
    } finally {
      inFlight.delete(position.id);
    }
  })();
  if (deps.dispatch) deps.dispatch(run);
  else void run;
}

/**
 * Runs one revision call and applies what comes back, if it can. Every outcome is recorded as an
 * FdsaPlanRevision row (the audit trail behind each later sale). A plan applies only when:
 *   - the call succeeded and the answer was usable (readFdsaReviseAnswer);
 *   - it clamps to a valid plan with its stop at or above the position's floor NOW, read after
 *     the call (applyFdsaRevision: a revision can tighten, never loosen - decision 8);
 *   - the position is still open on the plan version the call was asked about. A late answer
 *     (a sale closed it, or another revision landed first) is recorded as failed and dropped.
 * Anything else leaves the running plan in force.
 */
export async function reviseAndApply(reviser: FdsaReviser, request: FdsaRevisionRequest): Promise<void> {
  let result: FdsaRevisionResult;
  try {
    result = await reviser.revise(request);
  } catch (err) {
    result = { ok: false, error: errText(err) };
  }
  const current = await prisma.fdsaPosition.findUnique({ where: { id: request.positionId } });
  if (!current) return;
  const record = (
    status: "applied" | "kept" | "rejected" | "failed",
    extra: { plan?: FdsaExitPlan; error?: string | null; reason?: string | null; version?: number } = {},
  ) =>
    prisma.fdsaPlanRevision.create({
      data: {
        positionId: current.id,
        reviewId: result.reviewId ?? null,
        trigger: request.trigger,
        status,
        version: extra.version ?? current.planVersion,
        plan: extra.plan ? (extra.plan as unknown as Prisma.InputJsonValue) : Prisma.JsonNull,
        proposed:
          result.ok && result.read.verdict.proposed != null
            ? (result.read.verdict.proposed as Prisma.InputJsonValue)
            : Prisma.JsonNull,
        multiple: request.multiple,
        reason: extra.reason ?? null,
        error: extra.error ?? null,
      },
    });

  if (!result.ok) {
    await record("failed", { error: result.error });
    return;
  }
  const { verdict, error } = result.read;
  if (error !== null) {
    await record("rejected", { error, reason: verdict.reason || null });
    return;
  }
  if (verdict.action === "keep") {
    await record("kept", { reason: verdict.reason || null });
    return;
  }
  if (current.status !== "open") {
    await record("failed", {
      error: "late: the position closed before the revision landed",
      reason: verdict.reason,
    });
    return;
  }
  if (current.planVersion !== request.planVersion) {
    await record("failed", { error: "late: another revision landed first", reason: verdict.reason });
    return;
  }
  const plan = applyFdsaRevision(verdict.proposed, { floorMultiple: current.floorMultiple });
  if (!plan) {
    await record("rejected", { error: "proposed plan failed validation", reason: verdict.reason });
    return;
  }
  const version = current.planVersion + 1;
  const floor = Math.max(
    FDSA_HARD_FLOOR_MULTIPLE,
    current.floorMultiple,
    fdsaFloorMultiple(plan, current.peakMultiple, current.floorMultiple),
  );
  const applied = await prisma.$transaction(async (tx) => {
    const updated = await tx.fdsaPosition.updateMany({
      where: { id: current.id, status: "open", planVersion: current.planVersion },
      data: {
        exitPlan: plan as unknown as Prisma.InputJsonValue,
        planVersion: version,
        floorMultiple: floor,
      },
    });
    if (updated.count !== 1) return false;
    await tx.fdsaPlanRevision.create({
      data: {
        positionId: current.id,
        reviewId: result.reviewId ?? null,
        trigger: request.trigger,
        status: "applied",
        version,
        plan: plan as unknown as Prisma.InputJsonValue,
        proposed: (verdict.proposed ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        multiple: request.multiple,
        reason: verdict.reason || null,
      },
    });
    return true;
  });
  if (!applied)
    await record("failed", { error: "late: the position changed while applying", reason: verdict.reason });
}

// ── Loss limit ───────────────────────────────────────────────────────────────────────────────

/** The daily loss limit, as the bot applies it (engine.ts pausedForLoss): stops the desk. */
async function pausedForLoss(
  desk: DeskRow,
  config: FdsaDeskConfig,
  now: Date,
  notes: TradeNote[],
): Promise<boolean> {
  if (!(config.dailyLossLimitSol > 0)) return false;
  const closed = await prisma.fdsaPosition.findMany({
    where: { deskId: desk.id, status: "closed", closedAt: { gt: lossWindowStart(now, desk.lossWindowFrom) } },
    select: { swapInLamports: true, feesLamports: true, proceedsLamports: true },
  });
  const lost = netLoss(
    closed.map((p) => ({ paid: p.swapInLamports + p.feesLamports, back: p.proceedsLamports })),
  );
  if (lost < solToLamports(config.dailyLossLimitSol)) return false;
  const why = `stopped: lost ${solAmount(lost)} in the last 24 hours (limit ${config.dailyLossLimitSol} SOL)`;
  const stopped = await prisma.fdsaDesk.updateMany({
    where: { id: desk.id, running: true },
    data: { running: false, pausedReason: why },
  });
  if (stopped.count > 0)
    note(notes, "loss_limit", `⏸ ${escapeHtml(why)}. Open positions keep their exit plans.`);
  return true;
}

// ── Entries ──────────────────────────────────────────────────────────────────────────────────

/**
 * Buys fresh "trade" verdicts. A verdict is read again on every pass while it is fresh, so a buy
 * the reserve or the open-position cap held back is taken when room opens - but never past
 * maxSignalAgeSeconds from the alert (the bot's freshness rule), and never before the desk's
 * signalsFrom (set on each start, so it never trades a backlog).
 */
async function openEntries(
  deps: FdsaDeskDeps,
  desk: DeskRow,
  config: FdsaDeskConfig,
  summary: FdsaDeskSummary,
  now: () => Date,
  inBudget: () => boolean,
  notes: TradeNote[],
) {
  const t = now();
  const freshFrom = new Date(t.getTime() - config.maxSignalAgeSeconds * 1000);
  const intents = await prisma.fdsaReview.findMany({
    where: {
      stage: "decide",
      decision: "trade",
      alertAt: { gte: freshFrom > desk.signalsFrom ? freshFrom : desk.signalsFrom },
    },
    include: { token: { select: { mintAddress: true, symbol: true } } },
    orderBy: { alertAt: "asc" },
    take: MAX_INTENTS_PER_PASS,
  });
  if (intents.length === 0) return;
  const taken = await prisma.fdsaPosition.findMany({
    where: {
      deskId: desk.id,
      OR: [
        { reviewId: { in: intents.map((r) => r.id) } },
        { mint: { in: intents.map((r) => r.token.mintAddress) } },
      ],
    },
    select: { reviewId: true, mint: true },
  });
  const takenReviews = new Set(taken.map((p) => p.reviewId));
  const takenMints = new Set(taken.map((p) => p.mint));
  const buyLamports = solToLamports(config.buySol);
  const fee = paperSwapFee(config);
  const reserve = solToLamports(config.reserveSol);
  let cash = desk.cashLamports;
  const mints = new Map<string, Promise<MintInfo | null>>();

  for (const review of intents) {
    if (!inBudget()) return;
    if (takenReviews.has(review.id)) continue;
    const mint = review.token.mintAddress;
    summary.intents++;
    const skip = (why: string) => summary.skips.push({ reviewId: review.id, mint, why });
    if (takenMints.has(mint)) {
      skip("already traded this token");
      continue;
    }
    const plan = readFdsaExitPlan(review.exitPlan);
    if (!plan) {
      skip("no usable exit plan");
      continue;
    }
    const at = now();
    if (at.getTime() - review.alertAt.getTime() > config.maxSignalAgeSeconds * 1000) {
      skip("signal too old");
      continue;
    }
    const [open, spent] = await Promise.all([
      prisma.fdsaPosition.count({ where: { deskId: desk.id, status: "open" } }),
      prisma.fdsaPosition.aggregate({
        where: { deskId: desk.id, createdAt: { gt: new Date(at.getTime() - 24 * 3_600_000) } },
        _sum: { swapInLamports: true },
      }),
    ]);
    if (open >= config.maxOpenPositions) {
      skip("at the open-position limit");
      continue;
    }
    if ((spent._sum.swapInLamports ?? 0n) + buyLamports > solToLamports(config.maxDailySpendSol)) {
      skip("at the 24h spend limit");
      continue;
    }
    if (cash - buyLamports - fee < reserve) {
      skip("not enough paper SOL above the reserve");
      continue;
    }
    let info = mints.get(mint);
    if (!info) {
      info = deps.rpc.getMintInfo(mint).catch(() => null);
      mints.set(mint, info);
    }
    const mintInfo = await info;
    if (!mintInfo || mintInfo.decimals === undefined) {
      skip("mint unreadable");
      continue;
    }
    const risk = mintRisk(mintInfo);
    if (risk) {
      skip(risk);
      continue;
    }
    let fill: FdsaFillResult;
    try {
      fill = await deps.executor.buy({ mint, lamports: buyLamports, config });
    } catch (err) {
      if (err instanceof RateLimitedError) throw err;
      skip(`buy failed: ${errText(err)}`);
      continue;
    }
    if (!fill.ok) {
      skip(fill.error === "no route" ? "no route to buy" : fill.error);
      continue;
    }
    if (fill.tokens <= 0n) {
      skip("the fill bought nothing");
      continue;
    }
    const filledAt = now();
    const floor = fdsaFloorMultiple(plan, 1, FDSA_HARD_FLOOR_MULTIPLE);
    try {
      await prisma.$transaction(async (tx) => {
        const position = await tx.fdsaPosition.create({
          data: {
            deskId: desk.id,
            mode: deps.executor.mode,
            mint,
            symbol: review.token.symbol,
            tokenId: review.tokenId,
            sourceKind: "fdsa",
            reviewId: review.id,
            candidateOutcomeId: review.candidateOutcomeId,
            curatedAlertId: review.curatedAlertId,
            signalAt: review.alertAt,
            verdictAt: review.createdAt,
            openedAt: filledAt,
            status: "open",
            swapInLamports: fill.lamports,
            feesLamports: fill.feeLamports,
            tokensBought: fill.tokens.toString(),
            tokensHeld: fill.tokens.toString(),
            decimals: fill.decimals,
            exitPlan: plan as unknown as Prisma.InputJsonValue,
            planVersion: 1,
            floorMultiple: floor,
            peakMultiple: 1,
            lastMultiple: 1,
            lastPricedAt: filledAt,
          },
        });
        await tx.fdsaFill.create({
          data: {
            positionId: position.id,
            side: "buy",
            reason: "entry",
            planVersion: 1,
            lamports: fill.lamports,
            feeLamports: fill.feeLamports,
            tokens: fill.tokens.toString(),
            multiple: 1,
          },
        });
        await tx.fdsaPlanRevision.create({
          data: {
            positionId: position.id,
            reviewId: review.id,
            trigger: "entry",
            status: "applied",
            version: 1,
            plan: plan as unknown as Prisma.InputJsonValue,
            proposed: (review.exitPlan ?? Prisma.JsonNull) as Prisma.InputJsonValue,
            multiple: 1,
            reason: review.reasoning,
          },
        });
        const debited = await tx.fdsaDesk.updateMany({
          where: { id: desk.id, resetAt: desk.resetAt },
          data: { cashLamports: { decrement: fill.lamports + fill.feeLamports } },
        });
        if (debited.count === 0) throw new ResetUnderUs("desk reset during the pass");
      });
    } catch (err) {
      if (err instanceof ResetUnderUs) return;
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        // One entry per mint (FdsaPosition @@unique([deskId, mint])), and per review: a second
        // scanner got there first.
        skip("already traded this token");
        takenMints.add(mint);
        continue;
      }
      throw err;
    }
    cash -= fill.lamports + fill.feeLamports;
    takenMints.add(mint);
    summary.entries++;
    // Alert to fill: what a Live buy will have to beat maxSignalAgeSeconds with.
    const latencyMs = filledAt.getTime() - review.alertAt.getTime();
    logger.info("fdsa paper entry", { mint, reviewId: review.id, latencyMs });
    const pct = review.probability2x !== null ? `, ${Math.round(review.probability2x * 100)}% to 2x` : "";
    note(
      notes,
      "buy",
      `bought ${tokenLink(review.token.symbol, mint)} for ${solAmount(fill.lamports)}${pct}, ${Math.round(latencyMs / 1000)}s after the alert`,
    );
  }
}

function errText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 300);
}
