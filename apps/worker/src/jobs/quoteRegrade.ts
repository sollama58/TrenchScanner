import {
  prisma,
  createLogger,
  regradeFromCandles,
  FRESH_ANCHOR_LABEL_RULE,
  HttpError,
  Prisma,
  type MinuteCandle,
  type PumpFunClient,
} from "@trenchscanner/core";
import { GRADE_FIELDS, gradeOfReplay } from "./labelRegradeJob.js";
import { QUOTE_REGRADE_MINTS } from "./quoteRegradeMints.js";

const logger = createLogger("quote-regrade");

/**
 * Re-grades the outcomes of coins that trade only against another coin (user decision 2026-10-14,
 * project thread "non-standard pairs").
 *
 * Pump.fun lets a launch pair with any coin - PUMP, a tokenized stock, another launch - and
 * DexScreener answers such a pair with no USD price. Until PR #551 every lookup but the scan's band
 * refresh read the coin as $0, so the watcher saw its runs only through in-band snapshots: on the
 * 301 coins graded 2026-10-07..14 the candle replay finds 53 missed 2x rows and 13 false ones in
 * 1,308 (3.5% of rows flip either way on SOL-paired coins, 5% here, nearly all toward wins).
 *
 * Each outcome of those coins in the window, of every kind, is replayed through the coin's Pump.fun
 * minute candles the way the history re-grade does (regradeFromCandles), once. A row a curated
 * alert points at keeps the verdict the alert was published with and gets the replay as rule4Grade;
 * the rest take the replayed grade as rule 4. What each row had is kept in QuoteRegrade, written in
 * the same transaction, which is also what marks it done. Rows the candles can't vouch for keep
 * their grade. A few coins a run, gentle on Pump.fun; once nothing is left, a no-op that never asks
 * the database again in this process.
 */

const SINCE = new Date("2026-10-07T00:00:00Z");
/** PR #551's merge: outcomes after it were priced through the quote coin. */
const UNTIL = new Date("2026-10-14T23:33:00Z");
export const QUOTE_REGRADE_COINS_PER_RUN = 30;
const CALL_SPACING_MS = 400;

let finished = false;

/** Test hook. */
export function resetQuoteRegrade(): void {
  finished = false;
}

const ROW_SELECT = {
  id: true,
  tokenId: true,
  anchorAt: true,
  features: true,
  labelRule: true,
  regradedAt: true,
  rule3Grade: true,
  rule4Grade: true,
  ...Object.fromEntries(GRADE_FIELDS.map((f) => [f, true])),
  curatedAlerts: { select: { id: true }, take: 1 },
} as Prisma.CandidateOutcomeSelect;

type Row = {
  id: string;
  tokenId: string;
  anchorAt: Date;
  features: Prisma.JsonValue;
  labelRule: number;
  regradedAt: Date | null;
  rule3Grade: Prisma.JsonValue;
  rule4Grade: Prisma.JsonValue;
  curatedAlerts: { id: string }[];
} & Record<(typeof GRADE_FIELDS)[number], unknown> & { anchorPriceUsd: number; anchorMcapUsd: number };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runQuoteRegrade(
  pumpFun: Pick<PumpFunClient, "minuteCandles">,
  opts: { coinsPerRun?: number; spacingMs?: number; now?: () => number; mints?: readonly string[] } = {},
): Promise<Record<string, number> | null> {
  if (finished) return null;
  const now = opts.now ?? Date.now;
  const coinsPerRun = opts.coinsPerRun ?? QUOTE_REGRADE_COINS_PER_RUN;
  const spacingMs = opts.spacingMs ?? CALL_SPACING_MS;
  const mints = opts.mints ?? QUOTE_REGRADE_MINTS;

  const rows = (await prisma.candidateOutcome.findMany({
    where: {
      token: { mintAddress: { in: [...mints] } },
      anchorAt: { gte: SINCE, lt: UNTIL },
      finalizedAt: { not: null },
      finalized24hAt: { not: null },
    },
    select: ROW_SELECT,
  })) as unknown as Row[];
  const done = new Set(
    (
      await prisma.quoteRegrade.findMany({
        where: { outcomeId: { in: rows.map((r) => r.id) } },
        select: { outcomeId: true },
      })
    ).map((r) => r.outcomeId),
  );
  const byToken = new Map<string, Row[]>();
  for (const row of rows) {
    if (done.has(row.id)) continue;
    const list = byToken.get(row.tokenId);
    if (list) list.push(row);
    else byToken.set(row.tokenId, [row]);
  }
  if (byToken.size === 0) {
    finished = true;
    logger.info("quote re-grade finished", { rows: rows.length });
    return null;
  }

  const counts: Record<string, number> = {
    coins: 0,
    regraded: 0,
    alertRows: 0,
    skipped: 0,
    wins: 0,
    winsBefore: 0,
  };
  let throttled = false;
  for (const [i, [tokenId, tokenRows]] of [...byToken].slice(0, coinsPerRun).entries()) {
    if (i > 0) await sleep(spacingMs);
    const token = await prisma.token.findUnique({ where: { id: tokenId }, select: { mintAddress: true } });
    if (!token) continue;
    let candles: MinuteCandle[] | null;
    try {
      candles = await pumpFun.minuteCandles(token.mintAddress);
    } catch (err) {
      if (err instanceof HttpError && err.status === 429) {
        throttled = true;
        break;
      }
      logger.warn("candle read failed", { mint: token.mintAddress, error: String(err) });
      continue;
    }
    counts.coins! += 1;
    const nowMs = now();
    for (const row of tokenRows) {
      const current = row as unknown as Record<string, unknown>;
      const previous = {
        ...Object.fromEntries(GRADE_FIELDS.map((f) => [f, current[f] ?? null])),
        labelRule: row.labelRule,
        regradedAt: row.regradedAt,
        rule3Grade: row.rule3Grade,
        rule4Grade: row.rule4Grade,
      };
      const result = candles
        ? regradeFromCandles(
            {
              anchorAt: row.anchorAt,
              anchorPriceUsd: row.anchorPriceUsd,
              startsExtended: row.curatedAlerts.length > 0,
            },
            candles,
            nowMs,
          )
        : ({ skip: "no-candles" } as const);
      const record = (outcome: string) =>
        prisma.quoteRegrade.create({
          data: { outcomeId: row.id, previous: previous as Prisma.InputJsonValue, result: outcome },
        });
      if ("skip" in result) {
        counts.skipped! += 1;
        await record(result.skip);
        continue;
      }
      const { replay, gapPct } = result;
      const grade = gradeOfReplay(replay, row.anchorMcapUsd, row.anchorPriceUsd);
      if (replay.labels.hit2xIn1h && !replay.labels.disqualified) counts.wins! += 1;
      if (row.hit2xIn1h === true && row.disqualified === false) counts.winsBefore! += 1;
      if (row.curatedAlerts.length > 0) {
        // An alert's verdict was copied from this row: the row keeps it, and training reads this.
        counts.alertRows! += 1;
        await prisma.$transaction([
          record("alert"),
          prisma.candidateOutcome.update({
            where: { id: row.id },
            data: { rule4Grade: { ...grade, freshGapPct: gapPct } as Prisma.InputJsonValue },
          }),
        ]);
        continue;
      }
      counts.regraded! += 1;
      // A rule-3 row keeps its rule-3 grade where the history re-grade would have (and an earlier
      // re-grade's copy stays as it was); a row born rule 4 has its old grade in QuoteRegrade only.
      const rule3Grade =
        row.rule3Grade ??
        (row.labelRule === 3 ? Object.fromEntries(GRADE_FIELDS.map((f) => [f, current[f] ?? null])) : null);
      await prisma.$transaction([
        record("regraded"),
        prisma.candidateOutcome.update({
          where: { id: row.id },
          data: {
            ...grade,
            labelRule: FRESH_ANCHOR_LABEL_RULE,
            regradedAt: new Date(nowMs),
            rule3Grade: rule3Grade === null ? Prisma.DbNull : (rule3Grade as Prisma.InputJsonValue),
            // A row born rule 4 already has the live quote's gap; a rule-3 row gets the candles' one,
            // as the history re-grade gives it.
            ...(row.labelRule === 3
              ? {
                  features: {
                    ...(row.features as Record<string, unknown>),
                    freshGapPct: gapPct,
                  } as Prisma.InputJsonValue,
                }
              : {}),
          },
        }),
      ]);
    }
  }
  if (throttled) logger.warn("pump.fun throttled the candle reads - the rest wait for the next run");
  logger.info("quote re-grade run", {
    ...counts,
    coinsLeft: byToken.size - counts.coins!,
    throttled: Number(throttled),
  });
  return counts;
}
