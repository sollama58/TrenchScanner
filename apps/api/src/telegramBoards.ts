import {
  CALL_PEAK_READING_LAG_MS,
  MAX_ALERT_AGE_MS,
  prisma,
  type ActiveAlert,
  type BoardStats,
  type TelegramBoards,
} from "@trenchscanner/core";
import { callPeakPct, curatedAlertInclude, latestSnapshotsByToken, resolveOutcome } from "./curatedFeed.js";
import { summarizeFeed, type FeedStatsCard } from "./feedStats.js";
import { MATCH_OUTCOME_SELECT, currentMarketCap, matchOutcome } from "./routes/matches.js";

/**
 * The numbers behind the bot's /alerts and /trenchboard, for one linked chat: the tokens that
 * chat was actually sent (TelegramAlertSent, one row per token per chat), each graded as its
 * Live-tab card is - by the model call that raised it when there was one (a call folded into a
 * filter match shows the call), else by the filter match - with resolveOutcome and summarizeFeed,
 * so a hit rate here is the dashboard's hit rate.
 */

/**
 * How far before a send the alert behind it can be: the dispatcher steps over alerts older than
 * MAX_ALERT_AGE_MS, plus slack for the commit wait and the pass itself.
 */
const ALERT_LOOKBACK_MS = MAX_ALERT_AGE_MS + 2 * 60_000;
/** The chat was sent the alert after it was raised; a little slack for clocks. */
const ALERT_LOOKAHEAD_MS = 5_000;
/**
 * The bot has kept what each chat was sent since this (migration 20261010213000), so a window
 * reaching before it counts only what came after.
 */
export const TELEGRAM_SENT_RECORD_START = new Date("2026-10-10T21:30:00Z");
/** A market-cap reading older than this is not shown as "now". */
const NOW_READING_MAX_AGE_MS = 15 * 60_000;
/** Bounds a pathological chat; a real one is far below it even over a week. */
const MAX_SENT_ROWS = 5_000;

const CALL_SELECT = {
  id: true,
  tokenId: true,
  createdAt: true,
  model: true,
  modelName: true,
  anchorMcapUsd: true,
  peakMcapUsd: true,
  simReturnPct: true,
  peak1hReturnPct: true,
  maxDrawdown1hPct: true,
  hit2xIn15m: true,
  hit2xIn1h: true,
  hit4xIn1h: true,
  hit10xIn1h: true,
  disqualified: true,
  peak24hReturnPct: true,
  runPeakMinutes: true,
  outcomeFinalizedAt: true,
  candidateOutcome: {
    select: { ...curatedAlertInclude.candidateOutcome.select, simReturnPct: true },
  },
} as const;

interface GradedAlert {
  tokenId: string;
  mintAddress: string;
  symbol: string | null;
  name: string | null;
  sentAt: Date;
  source: ActiveAlert["source"];
  outcome: ReturnType<typeof resolveOutcome>;
  alertMcapUsd: number | null;
  peakPct: number | null;
  /** The exit plan's return, once the position is out. */
  returnPct: number | null;
  /** Its grading row is still watching it. */
  tracking: boolean;
  /**
   * When a model call, or a filter alert priced from a fresh quote, went out: market-cap readings
   * from its first minute don't count as "now".
   */
  calledAt: Date | null;
}

/** The earliest of `rows` raised for a send at `sentAt`. */
export function alertFor<T extends { tokenId: string }>(
  rows: readonly T[],
  at: (r: T) => Date,
  tokenId: string,
  sentAt: Date,
): T | undefined {
  const from = sentAt.getTime() - ALERT_LOOKBACK_MS;
  const to = sentAt.getTime() + ALERT_LOOKAHEAD_MS;
  let best: T | undefined;
  for (const r of rows) {
    if (r.tokenId !== tokenId) continue;
    const t = at(r).getTime();
    if (t < from || t > to) continue;
    if (!best || t < at(best).getTime()) best = r;
  }
  return best;
}

async function gradedAlerts(chatRowId: string, since: Date) {
  const chat = await prisma.telegramChat.findUnique({
    where: { id: chatRowId },
    select: { userId: true, createdAt: true },
  });
  if (!chat) return { chat: null, alerts: [] as GradedAlert[] };
  const sent = await prisma.telegramAlertSent.findMany({
    where: { chatId: chatRowId, sentAt: { gte: since } },
    orderBy: { sentAt: "desc" },
    take: MAX_SENT_ROWS,
    select: { tokenId: true, sentAt: true },
  });
  if (sent.length === 0) return { chat, alerts: [] as GradedAlert[] };
  const tokenIds = [...new Set(sent.map((s) => s.tokenId))];
  const earliest = new Date(Math.min(...sent.map((s) => s.sentAt.getTime())) - ALERT_LOOKBACK_MS);

  const [tokens, calls, matches] = await Promise.all([
    prisma.token.findMany({
      where: { id: { in: tokenIds } },
      select: { id: true, mintAddress: true, symbol: true, name: true },
    }),
    prisma.curatedAlert.findMany({
      where: { tokenId: { in: tokenIds }, createdAt: { gte: earliest } },
      select: CALL_SELECT,
    }),
    prisma.match.findMany({
      where: { userId: chat.userId, tokenId: { in: tokenIds }, matchedAt: { gte: earliest } },
      select: {
        id: true,
        tokenId: true,
        peakReturnPct: true,
        filter: { select: { name: true } },
        snapshot: { select: { marketCapUsd: true } },
        alertMcapUsd: true,
        ...MATCH_OUTCOME_SELECT,
      },
    }),
  ]);
  const outcomeIds = [
    ...new Set(matches.flatMap((m) => (m.candidateOutcomeId ? [m.candidateOutcomeId] : []))),
  ];
  const rows =
    outcomeIds.length === 0
      ? []
      : await prisma.candidateOutcome.findMany({
          where: { id: { in: outcomeIds } },
          select: { id: true, ...curatedAlertInclude.candidateOutcome.select, simReturnPct: true },
        });
  const rowById = new Map(rows.map(({ id, ...row }) => [id, row]));
  const tokenById = new Map(tokens.map((t) => [t.id, t]));

  const alerts: GradedAlert[] = [];
  for (const s of sent) {
    const token = tokenById.get(s.tokenId);
    if (!token) continue;
    const base = {
      tokenId: s.tokenId,
      mintAddress: token.mintAddress,
      symbol: token.symbol,
      name: token.name,
      sentAt: s.sentAt,
    };
    // The call, as the Live tab shows a call folded into a filter match.
    const call = alertFor(calls, (c) => c.createdAt, s.tokenId, s.sentAt);
    if (call) {
      const outcome = resolveOutcome(call);
      alerts.push({
        ...base,
        source: { kind: "model", name: call.modelName ?? call.model ?? "A model" },
        outcome,
        alertMcapUsd: call.anchorMcapUsd > 0 ? call.anchorMcapUsd : null,
        peakPct: callPeakPct(outcome.peak24hReturnPct, call),
        returnPct: call.simReturnPct ?? call.candidateOutcome?.simReturnPct ?? null,
        tracking: call.candidateOutcome !== null && call.candidateOutcome.finalized24hAt === null,
        calledAt: call.createdAt,
      });
      continue;
    }
    const match = alertFor(matches, (m) => m.matchedAt, s.tokenId, s.sentAt);
    if (match) {
      const row = match.candidateOutcomeId ? (rowById.get(match.candidateOutcomeId) ?? null) : null;
      const outcome = matchOutcome(match, rowById);
      alerts.push({
        ...base,
        source: { kind: "filter", name: match.filter.name },
        outcome,
        // The price it was priced at (Match.alertMcapUsd), which its Peak counts from.
        alertMcapUsd:
          (match.alertMcapUsd ?? match.snapshot.marketCapUsd) > 0
            ? (match.alertMcapUsd ?? match.snapshot.marketCapUsd)
            : null,
        peakPct: match.peakReturnPct ?? outcome.peak24hReturnPct,
        returnPct: row?.simReturnPct ?? null,
        tracking: row !== null && row.finalized24hAt === null,
        // Priced from a fresh quote: its readings from the first minute lag behind it, as a call's.
        calledAt: match.alertMcapUsd !== null ? match.matchedAt : null,
      });
      continue;
    }
    // The alert behind it is gone (its filter was deleted): counted, never graded.
    alerts.push({
      ...base,
      source: { kind: "filter", name: "a deleted filter" },
      outcome: resolveOutcome({
        createdAt: s.sentAt,
        peak1hReturnPct: null,
        maxDrawdown1hPct: null,
        hit2xIn15m: null,
        hit2xIn1h: null,
        hit4xIn1h: null,
        hit10xIn1h: null,
        disqualified: null,
        peak24hReturnPct: null,
        runPeakMinutes: null,
        outcomeFinalizedAt: s.sentAt,
        candidateOutcome: null,
      }),
      alertMcapUsd: null,
      peakPct: null,
      returnPct: null,
      tracking: false,
      calledAt: null,
    });
  }
  return { chat, alerts };
}

/**
 * Each token's market cap now: the newer of its live reading and its newest snapshot (as the
 * dashboard's "Now", currentMarketCap), with when it was read. A reading older than
 * NOW_READING_MAX_AGE_MS is left out rather than shown as "now". This used to take a 14-minute-old
 * live ping over a snapshot from seconds ago, and fall back to a snapshot of any age.
 */
async function marketCapsNow(
  tokenIds: string[],
  now: number,
): Promise<Map<string, { marketCapUsd: number; at: Date }>> {
  const out = new Map<string, { marketCapUsd: number; at: Date }>();
  if (tokenIds.length === 0) return out;
  const [live, snaps] = await Promise.all([
    prisma.token.findMany({
      where: { id: { in: tokenIds } },
      select: { id: true, liveMarketCapUsd: true, liveDataAt: true },
    }),
    latestSnapshotsByToken(tokenIds),
  ]);
  for (const t of live) {
    const current = currentMarketCap(t, snaps.get(t.id) ?? null);
    if (current.marketCapUsd === null || !(current.marketCapUsd > 0) || !current.at) continue;
    if (now - current.at.getTime() > NOW_READING_MAX_AGE_MS) continue;
    out.set(t.id, { marketCapUsd: current.marketCapUsd, at: current.at });
  }
  return out;
}

/**
 * An active alert's "now" market cap, or null when there is none to show: a model call's readings
 * from its first minute still show the market from before the call (CALL_PEAK_READING_LAG_MS).
 */
export function nowMcapFor(
  alert: { calledAt: Date | null },
  reading: { marketCapUsd: number; at: Date } | undefined,
): number | null {
  if (!reading) return null;
  if (alert.calledAt && reading.at.getTime() < alert.calledAt.getTime() + CALL_PEAK_READING_LAG_MS)
    return null;
  return reading.marketCapUsd;
}

/**
 * The Peak an active alert shows: a "now" above the recorded peak is already a peak (the worker
 * banks it on its next pass), so "Now +316% · Peak +50%" can't show, as on the dashboard's card.
 */
export function activePeakPct(
  peakPct: number | null,
  alertMcapUsd: number | null,
  nowMcapUsd: number | null,
) {
  if (alertMcapUsd === null || !(alertMcapUsd > 0) || nowMcapUsd === null) return peakPct;
  const move = (nowMcapUsd / alertMcapUsd - 1) * 100;
  return move > 0 ? Math.max(peakPct ?? 0, move) : peakPct;
}

/** The longest any alert is tracked: a clean winner's 24-hour watch. */
const ACTIVE_LOOKBACK_MS = 25 * 3_600_000;

export function createTelegramBoards(now: () => number = Date.now): TelegramBoards {
  return {
    async activeAlerts(chatRowId) {
      const t = now();
      const { alerts } = await gradedAlerts(chatRowId, new Date(t - ACTIVE_LOOKBACK_MS));
      const tracking = alerts.filter((a) => a.tracking);
      const mcaps = await marketCapsNow(
        tracking.map((a) => a.tokenId),
        t,
      );
      return tracking.map((a): ActiveAlert => {
        const nowMcapUsd = nowMcapFor(a, mcaps.get(a.tokenId));
        return {
          mintAddress: a.mintAddress,
          symbol: a.symbol,
          name: a.name,
          sentAt: a.sentAt,
          source: a.source,
          alertMcapUsd: a.alertMcapUsd,
          nowMcapUsd,
          peakPct: activePeakPct(a.peakPct, a.alertMcapUsd, nowMcapUsd),
          status: a.outcome.status,
          hit2x: a.outcome.hit2x,
          minutesLeft: a.outcome.minutesLeft,
        };
      });
    },

    async board(chatRowId, hours): Promise<BoardStats> {
      const t = now();
      const start = new Date(t - hours * 3_600_000);
      const { chat, alerts } = await gradedAlerts(chatRowId, start);
      const cards: FeedStatsCard[] = alerts.map((a) => ({
        kind: a.source.kind === "model" ? "curated" : "match",
        tokenId: a.tokenId,
        symbol: a.symbol,
        outcome: a.outcome,
        peakPct: a.peakPct,
      }));
      const s = summarizeFeed(cards, hours);
      const settled = alerts.flatMap((a) =>
        a.returnPct !== null && Number.isFinite(a.returnPct) ? [a.returnPct] : [],
      );
      const best = s.best ? alerts.find((a) => a.tokenId === s.best!.tokenId) : undefined;
      const recordFrom = new Date(
        Math.max(TELEGRAM_SENT_RECORD_START.getTime(), chat?.createdAt.getTime() ?? 0),
      );
      return {
        hours,
        alerts: s.alerts,
        graded: s.graded,
        won: s.hit2x,
        lost: s.graded - s.hit2x,
        pending: s.pending,
        settled: settled.length,
        avgReturnPct: settled.length === 0 ? null : settled.reduce((x, y) => x + y, 0) / settled.length,
        best:
          s.best && best
            ? { symbol: best.symbol, mintAddress: best.mintAddress, peakPct: s.best.peakPct }
            : null,
        recordedSince: recordFrom > start ? recordFrom : null,
      };
    },
  };
}
