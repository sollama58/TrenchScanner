import type { FastifyInstance, FastifyReply } from "fastify";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import {
  DEFAULT_FDSA_BANKROLL_SOL,
  DEFAULT_FDSA_DESK_CONFIG,
  FDSA_AVAILABLE_MODES,
  FDSA_DESK_ID,
  FDSA_HARD_FLOOR_MULTIPLE,
  FDSA_MODES,
  FDSA_PROMPT_VERSION,
  EXIT_PLAN,
  describeExitPlan,
  fdsaDeskConfigSchema,
  isWin,
  paperStats,
  prisma,
  readFdsaBudget,
  readFdsaDeskConfig,
  readFdsaExitPlan,
  readFdsaMode,
  readWorkerConfig,
  solToLamports,
  type Env,
} from "@trenchscanner/core";

/**
 * Admin > FDSA (moved from the hidden #fdsa tab on 2026-11-01, user ask; owner decision
 * 2026-10-31 for the desk itself) and its API at /admin/fdsa: the desk's mode and running state,
 * today's spend against FDSA's own cap, the review counts, open and closed paper positions with
 * their exit plans and plan history, FDSA's record against the goal metric with sample sizes and
 * the pool's base rate, its exit P&L against the default ladder on the same alerts, and the recent
 * reviews with their reasoning. The read-only page readers see at #fdsa is routes/fdsaPublic.ts.
 *
 * Admin wallets only: registered behind authenticateAdmin in server.ts, so anyone else gets a
 * 401 or 403.
 *
 * Paper only (decision 6): a mode change to "live" is refused here, and a CHECK on FdsaDesk.mode
 * refuses it in the database too. Nothing here holds a key, builds a transaction or signs; the
 * controls only write the desk row and flag positions for the paper pass to close.
 */

const DAY_MS = 86_400_000;
const MAX_POSITIONS_SHOWN = 50;
const MAX_REVISIONS_SHOWN = 20;

const patchSchema = z
  .object({
    /** "paper"; "live" is named so the answer can say it is not available yet. */
    mode: z.enum(FDSA_MODES).optional(),
    running: z.boolean().optional(),
    config: fdsaDeskConfigSchema.optional(),
  })
  .strict();
const resetSchema = z.object({ bankrollSol: z.number().positive().max(1_000_000).optional() }).strict();
const recordSchema = z.object({ days: z.coerce.number().int().min(1).max(90).default(30) });
const reviewsSchema = z.object({
  stage: z.enum(["screen", "decide", "revise", "all"]).default("all"),
  /** "trade" or "pass" (decide), "shortlist" or "drop" (screen), "error" for a failed call. */
  decision: z.string().min(1).max(20).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const lamports = (v: bigint) => v.toString();

function badRequest(reply: FastifyReply, error: z.ZodError) {
  const issue = error.issues[0];
  return reply
    .code(400)
    .send({ error: issue ? `${issue.path.join(".") || "body"}: ${issue.message}` : "invalid request" });
}

/** The desk row, created with the paper defaults on first use (owner decisions 2026-10-31, 2026-11-01). */
export async function ensureFdsaDesk() {
  const bankroll = solToLamports(DEFAULT_FDSA_BANKROLL_SOL);
  return prisma.fdsaDesk.upsert({
    where: { id: FDSA_DESK_ID },
    update: {},
    create: {
      id: FDSA_DESK_ID,
      mode: "paper",
      running: false,
      config: DEFAULT_FDSA_DESK_CONFIG as unknown as Prisma.InputJsonValue,
      bankrollLamports: bankroll,
      cashLamports: bankroll,
    },
  });
}

/** A rate with its sample: wins over graded, null while nothing is graded. */
export interface Rate {
  total: number;
  graded: number;
  wins: number;
  rate: number | null;
  /** Clean 4x inside the goal window, over the same graded rows. */
  wins4x: number;
}
export const rate = (total: number, graded: number, wins: number, wins4x: number): Rate => ({
  total,
  graded,
  wins,
  rate: graded > 0 ? wins / graded : null,
  wins4x,
});
export const num = (v: bigint | number | null | undefined) => (v === null || v === undefined ? 0 : Number(v));

/**
 * Whether an outcome row won, in SQL: the same test as curation/labels.ts isWin (a positive
 * labelValue: a clean 2x inside the 15-minute win window before the -50% stop). Only rows whose
 * window has closed (finalizedAt) count as graded.
 */
/** AiReplayRun.purpose of the decide replay (worker's fdsa/decideReplay.ts, FDSA_DECIDE_REPLAY_PURPOSE). */
const FDSA_DECIDE_REPLAY_PURPOSE = "fdsa-decide";
/** How many replay runs /replay lists: one per tag, and tags are rare. */
const REPLAY_RUNS = 10;

const GRADED = Prisma.sql`o."finalizedAt" IS NOT NULL AND o."labelValue" IS NOT NULL`;
const WON = Prisma.sql`${GRADED} AND o."labelValue" > 0`;
const WON_4X = Prisma.sql`${GRADED} AND o."labelValue" > 0 AND COALESCE(o."hit4xIn1h", false)`;

/** The plan as the tab shows it: validated, or null when the stored one can't be read. */
function planView(raw: unknown) {
  return readFdsaExitPlan(raw);
}

export function pnl(p: { swapInLamports: bigint; feesLamports: bigint; proceedsLamports: bigint }) {
  const paid = p.swapInLamports + p.feesLamports;
  const back = p.proceedsLamports;
  return {
    pnlLamports: lamports(back - paid),
    pnlPct: paid > 0n ? (Number(back - paid) / Number(paid)) * 100 : null,
  };
}

export async function registerFdsaRoutes(app: FastifyInstance, { env }: { env: Env }) {
  /** The desk, today's spend, review counts and what the worker reports. */
  app.get("/", async () => {
    const now = new Date();
    const dayStart = new Date(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`);
    const desk = await ensureFdsaDesk();
    const [budget, today, last24h, openCount, scanBeat, fdsaBeats, positions] = await Promise.all([
      readFdsaBudget(env, now),
      reviewCounts(dayStart),
      reviewCounts(new Date(now.getTime() - DAY_MS)),
      prisma.fdsaPosition.count({ where: { deskId: FDSA_DESK_ID, status: "open" } }),
      prisma.systemHeartbeat.findUnique({ where: { job: "scan" }, select: { lastRunAt: true, meta: true } }),
      prisma.systemHeartbeat.findMany({
        where: { job: { startsWith: "fdsa" } },
        select: { job: true, lastRunAt: true, lastSuccessAt: true, lastError: true, meta: true },
      }),
      prisma.fdsaPosition.findMany({
        // The bankroll's own trades: a reset starts a new one (history is kept for the record).
        where: { deskId: FDSA_DESK_ID, openedAt: { gte: desk.resetAt } },
        select: {
          id: true,
          status: true,
          swapInLamports: true,
          feesLamports: true,
          proceedsLamports: true,
          tokensBought: true,
          tokensHeld: true,
          lastMultiple: true,
          candidateOutcomeId: true,
        },
      }),
    ]);
    const config = readFdsaDeskConfig(desk.config);
    const graded = await outcomesById(positions.map((p) => p.candidateOutcomeId));
    const stats = paperStats(
      desk,
      positions.map((p) => ({ ...p, hit2x: hit2xOf(graded.get(p.candidateOutcomeId ?? "")) })),
    );
    // The scanner's own FDSA settings when its heartbeat reports them: FDSA_ENABLED and the screen
    // threshold are the worker's env, not this API service's.
    const worker = readWorkerConfig(scanBeat?.meta);
    const workerFdsa = (() => {
      const m = scanBeat?.meta as Record<string, unknown> | null | undefined;
      const f = m?.fdsa;
      return typeof f === "object" && f !== null && !Array.isArray(f) ? (f as Record<string, unknown>) : null;
    })();
    const setting = <T extends string | number | boolean>(key: string, fallback: T): T => {
      const v = worker?.settings[key];
      return typeof v === typeof fallback ? (v as T) : fallback;
    };
    return {
      desk: {
        mode: readFdsaMode(desk.mode),
        modes: FDSA_MODES.map((m) => ({ id: m, available: FDSA_AVAILABLE_MODES.includes(m) })),
        running: desk.running,
        pausedReason: desk.pausedReason,
        config,
        defaults: { config: DEFAULT_FDSA_DESK_CONFIG, bankrollSol: DEFAULT_FDSA_BANKROLL_SOL },
        bankrollLamports: lamports(desk.bankrollLamports),
        cashLamports: lamports(desk.cashLamports),
        openPositions: openCount,
        resetAt: desk.resetAt,
        signalsFrom: desk.signalsFrom,
        lastRunAt: desk.lastRunAt,
        lastError: desk.lastError,
        updatedBy: desk.updatedBy,
        updatedAt: desk.updatedAt,
        stats: {
          ...stats,
          equityLamports: lamports(stats.equityLamports),
          openValueLamports: lamports(stats.openValueLamports),
          pnlLamports: lamports(stats.pnlLamports),
        },
      },
      settings: {
        // null when the scanner hasn't reported it (an older worker, or no scan yet).
        // The review pipeline's own heartbeat line (worker fdsa/review.ts fdsaHeartbeat) first,
        // then the scanner's reported env.
        enabled:
          typeof workerFdsa?.enabled === "boolean"
            ? workerFdsa.enabled
            : worker && "fdsaEnabled" in worker.settings
              ? setting("fdsaEnabled", false)
              : null,
        apiKeySet: worker?.credentials.anthropicApiKey ?? null,
        screenSource: setting("fdsaScreenSource", env.FDSA_SCREEN_SOURCE),
        screenModel: setting("fdsaScreenModel", env.FDSA_SCREEN_MODEL),
        screenMinScore: setting("fdsaScreenMinScore", env.FDSA_SCREEN_MIN_SCORE),
        screenShortlistPct: setting("fdsaScreenShortlistPct", env.FDSA_SCREEN_SHORTLIST_PCT),
        tradeTopPct: setting("fdsaTradeTopPct", env.FDSA_TRADE_TOP_PCT),
        decideModel: setting("fdsaDecideModel", env.FDSA_DECIDE_MODEL),
        decideEffort: setting("fdsaDecideEffort", env.FDSA_DECIDE_EFFORT),
        promptVersion: FDSA_PROMPT_VERSION,
        hardFloorMultiple: FDSA_HARD_FLOOR_MULTIPLE,
      },
      budget,
      reviews: { today, last24h },
      worker: {
        scanAt: scanBeat?.lastRunAt ?? null,
        fdsa: workerFdsa,
        heartbeats: fdsaBeats,
      },
    };
  });

  /** Mode (paper only), pause/resume and the editable paper limits. */
  app.patch("/", async (request, reply) => {
    const parsed = patchSchema.safeParse(request.body ?? {});
    if (!parsed.success) return badRequest(reply, parsed.error);
    const { mode, running, config } = parsed.data;
    if (mode !== undefined && !FDSA_AVAILABLE_MODES.includes(mode)) {
      // Decision 6 (2026-10-31): Live is not built. The CHECK on FdsaDesk.mode refuses it too.
      return reply.code(400).send({ error: `${mode} mode is not available yet; FDSA trades on paper only` });
    }
    const desk = await ensureFdsaDesk();
    const starting = running === true && !desk.running;
    const now = new Date();
    const updated = await prisma.fdsaDesk.update({
      where: { id: FDSA_DESK_ID },
      data: {
        ...(mode !== undefined ? { mode } : {}),
        ...(running !== undefined ? { running } : {}),
        // Pausing or resuming by hand clears why it stopped itself.
        ...(running !== undefined ? { pausedReason: null } : {}),
        // Starting reads alerts from now, so it never trades a backlog, and the daily loss limit
        // counts from now (the paper strategies' rule, trading/paper.ts).
        ...(starting ? { signalsFrom: now, lossWindowFrom: now, lastError: null } : {}),
        ...(config ? { config: config as unknown as Prisma.InputJsonValue } : {}),
        updatedBy: request.user!.walletAddress,
      },
    });
    return {
      mode: readFdsaMode(updated.mode),
      running: updated.running,
      config: readFdsaDeskConfig(updated.config),
    };
  });

  /**
   * A fresh paper bankroll. Refused while positions are open: their SOL would vanish from the
   * books. Unlike a paper strategy's reset it deletes nothing - every position and review stays,
   * so FDSA's record against the goal metric and the ladder keeps its whole sample; the bankroll's
   * P&L counts from the reset (resetAt).
   */
  app.post("/reset", async (request, reply) => {
    const parsed = resetSchema.safeParse(request.body ?? {});
    if (!parsed.success) return badRequest(reply, parsed.error);
    const desk = await ensureFdsaDesk();
    const bankroll =
      parsed.data.bankrollSol !== undefined ? solToLamports(parsed.data.bankrollSol) : desk.bankrollLamports;
    const now = new Date();
    const reset = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "FdsaDesk" WHERE "id" = ${FDSA_DESK_ID} FOR UPDATE`;
      const open = await tx.fdsaPosition.count({ where: { deskId: FDSA_DESK_ID, status: "open" } });
      if (open > 0) return open;
      await tx.fdsaDesk.update({
        where: { id: FDSA_DESK_ID },
        data: {
          bankrollLamports: bankroll,
          cashLamports: bankroll,
          resetAt: now,
          signalsFrom: now,
          lossWindowFrom: now,
          pausedReason: null,
          lastError: null,
          updatedBy: request.user!.walletAddress,
        },
      });
      return 0;
    });
    if (reset > 0) {
      return reply.code(409).send({
        error: `${reset} position${reset === 1 ? " is" : "s are"} still open; close ${reset === 1 ? "it" : "them"} first`,
      });
    }
    return { ok: true };
  });

  /** Sells one open position on the paper pass's next tick ("manual"). */
  app.post<{ Params: { id: string } }>("/positions/:id/close", async (request, reply) => {
    const updated = await prisma.fdsaPosition.updateMany({
      where: { id: request.params.id, deskId: FDSA_DESK_ID, status: "open" },
      data: { closeRequested: true },
    });
    if (updated.count === 0) return reply.code(404).send({ error: "no open FDSA position with that id" });
    return { ok: true };
  });

  /** Open positions with their plan and plan history; the latest closed trades with P&L. */
  app.get("/positions", async () => {
    const [open, closed] = await Promise.all([
      prisma.fdsaPosition.findMany({
        where: { deskId: FDSA_DESK_ID, status: "open" },
        orderBy: { openedAt: "desc" },
        include: {
          revisions: { orderBy: { createdAt: "desc" }, take: MAX_REVISIONS_SHOWN },
          fills: { orderBy: { createdAt: "asc" } },
        },
      }),
      prisma.fdsaPosition.findMany({
        where: { deskId: FDSA_DESK_ID, status: { not: "open" } },
        orderBy: { closedAt: "desc" },
        take: MAX_POSITIONS_SHOWN,
        include: {
          revisions: { orderBy: { createdAt: "desc" }, take: MAX_REVISIONS_SHOWN },
          fills: { orderBy: { createdAt: "asc" } },
        },
      }),
    ]);
    const outcomes = await outcomesById([...open, ...closed].map((p) => p.candidateOutcomeId));
    const view = (p: (typeof open)[number]) => {
      const o = p.candidateOutcomeId ? outcomes.get(p.candidateOutcomeId) : undefined;
      const hit2x = hit2xOf(o);
      return {
        id: p.id,
        mode: p.mode,
        mint: p.mint,
        symbol: p.symbol,
        status: p.status,
        signalAt: p.signalAt,
        verdictAt: p.verdictAt,
        openedAt: p.openedAt,
        closedAt: p.closedAt,
        // End to end, alert -> verdict -> fill, against the desk's maxSignalAgeSeconds.
        verdictLatencyMs: p.verdictAt ? p.verdictAt.getTime() - p.signalAt.getTime() : null,
        fillLatencyMs: p.openedAt.getTime() - p.signalAt.getTime(),
        holdMs: (p.closedAt ?? new Date()).getTime() - p.openedAt.getTime(),
        swapInLamports: lamports(p.swapInLamports),
        feesLamports: lamports(p.feesLamports),
        proceedsLamports: lamports(p.proceedsLamports),
        ...pnl(p),
        soldFraction: p.soldFraction,
        partialsTaken: p.partialsTaken,
        lastMultiple: p.lastMultiple,
        lastPricedAt: p.lastPricedAt,
        peakMultiple: p.peakMultiple,
        floorMultiple: Math.max(FDSA_HARD_FLOOR_MULTIPLE, p.floorMultiple),
        planVersion: p.planVersion,
        plan: planView(p.exitPlan),
        closeRequested: p.closeRequested,
        closeReason: p.closeReason,
        error: p.error,
        // The alert's own grade: the goal metric, and what the default ladder made on it.
        hit2x,
        hit4x: hit2x === null ? null : hit2x && o?.hit4xIn1h === true,
        ladderReturnPct: o?.simReturnPct ?? null,
        revisions: p.revisions.map((r) => ({
          id: r.id,
          trigger: r.trigger,
          status: r.status,
          version: r.version,
          plan: r.plan === null ? null : planView(r.plan),
          multiple: r.multiple,
          reason: r.reason,
          error: r.error,
          createdAt: r.createdAt,
        })),
        fills: p.fills.map((f) => ({
          side: f.side,
          reason: f.reason,
          planVersion: f.planVersion,
          lamports: lamports(f.lamports),
          feeLamports: lamports(f.feeLamports),
          multiple: f.multiple,
          createdAt: f.createdAt,
        })),
      };
    };
    return { open: open.map(view), closed: closed.map(view) };
  });

  /**
   * FDSA's record against the goal metric (a clean 2x inside 15 minutes before the -50% stop):
   * on the trades it took, on its "trade" verdicts, on its passes and on its screen drops, each
   * with its sample, next to the pool's base rate (every alert it screened). And its exit P&L
   * against what the default ladder (EXIT_PLAN, profitSim.ts, stored per alert as simReturnPct)
   * made on the same alerts - the evidence for whether the adaptive exits earn their keep.
   */
  app.get("/record", async (request, reply) => {
    const parsed = recordSchema.safeParse(request.query);
    if (!parsed.success) return badRequest(reply, parsed.error);
    return fdsaRecord(parsed.data.days);
  });

  /**
   * The exit lab's latest report (worker's fdsaExitLabJob.ts): the tuned plan and every baseline,
   * as the run's heartbeat meta holds them. The worker report (/worker) keeps only a run's numbers
   * and flags, so the summaries and plans are read here. Null before the lab's first run.
   */
  app.get("/lab", async () => {
    const row = await prisma.systemHeartbeat.findUnique({ where: { job: "fdsa-exit-lab" } });
    if (!row) return { ranAt: null, report: null };
    return { ranAt: row.lastRunAt, lastError: row.lastError, report: row.meta ?? null };
  });

  /**
   * The decide replay's runs (worker's fdsa/decideReplay.ts, FDSA_DECIDE_REPLAY): each tag's run
   * with its per-variant scorecard - the replayed decide at each effort against the scanner model
   * on the same graded alerts - as the run row holds it. The worker report (/worker) keeps only a
   * run's top-level numbers, so the scorecards are read here. Newest first, at most REPLAY_RUNS.
   */
  app.get("/replay", async () => {
    const runs = await prisma.aiReplayRun.findMany({
      where: { purpose: FDSA_DECIDE_REPLAY_PURPOSE },
      orderBy: { createdAt: "desc" },
      take: REPLAY_RUNS,
      select: {
        id: true,
        status: true,
        model: true,
        playbookIds: true,
        requestCount: true,
        estimatedCostUsd: true,
        costUsd: true,
        createdAt: true,
        scoredAt: true,
        metrics: true,
        error: true,
      },
    });
    return {
      runs: runs.map((r) => {
        const metrics = (r.metrics ?? {}) as Record<string, Record<string, number | null>>;
        return {
          id: r.id,
          // The variant ids are "<tag>:<effort>" (decideReplay.ts); the tag names the run.
          tag: r.playbookIds[0]?.slice(0, r.playbookIds[0].lastIndexOf(":")) ?? null,
          status: r.status,
          model: r.model,
          requests: r.requestCount,
          estimatedCostUsd: r.estimatedCostUsd,
          costUsd: r.costUsd,
          submittedAt: r.createdAt,
          scoredAt: r.scoredAt,
          error: r.error,
          variants: r.playbookIds.map((id) => ({
            id,
            effort: id.slice(id.lastIndexOf(":") + 1),
            ...(metrics[id] ?? null),
          })),
        };
      }),
    };
  });

  /** The latest reviews, passes included, with the model's reasoning (stored text, shown as text). */
  app.get("/reviews", async (request, reply) => {
    const parsed = reviewsSchema.safeParse(request.query);
    if (!parsed.success) return badRequest(reply, parsed.error);
    const { stage, decision, limit } = parsed.data;
    const rows = await prisma.fdsaReview.findMany({
      where: {
        ...(stage !== "all" ? { stage } : {}),
        ...(decision === "error" ? { decision: null } : decision ? { decision } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: {
        id: true,
        stage: true,
        model: true,
        answeredBy: true,
        effort: true,
        promptVersion: true,
        decision: true,
        score: true,
        probability2x: true,
        probability4x: true,
        conviction: true,
        exitPlan: true,
        reasoning: true,
        risks: true,
        error: true,
        refused: true,
        costUsd: true,
        latencyMs: true,
        alertAt: true,
        anchorMcapUsd: true,
        positionId: true,
        createdAt: true,
        token: { select: { symbol: true, mintAddress: true } },
        candidateOutcome: { select: { finalizedAt: true, labelValue: true } },
      },
    });
    return rows.map(({ token, candidateOutcome: o, exitPlan, ...r }) => ({
      ...r,
      exitPlan: exitPlan === null ? null : planView(exitPlan),
      symbol: token.symbol,
      mint: token.mintAddress,
      hit2x: hit2xOf(o ? { ...o, hit4xIn1h: null, simReturnPct: null } : undefined),
    }));
  });
}

/** The alerts' outcome rows by id (FdsaPosition.candidateOutcomeId is a plain id, not a relation). */
export async function outcomesById(ids: (string | null)[]) {
  const wanted = [...new Set(ids.filter((x): x is string => !!x))];
  if (wanted.length === 0) return new Map<string, Outcome>();
  const rows = await prisma.candidateOutcome.findMany({
    where: { id: { in: wanted } },
    select: { id: true, finalizedAt: true, labelValue: true, hit4xIn1h: true, simReturnPct: true },
  });
  return new Map<string, Outcome>(rows.map((o) => [o.id, o]));
}
interface Outcome {
  finalizedAt: Date | null;
  labelValue: number | null;
  hit4xIn1h: boolean | null;
  simReturnPct: number | null;
}
/** The goal metric on one alert (curation/labels.ts isWin), null while its window is open. */
export function hit2xOf(o: Outcome | undefined): boolean | null {
  return o?.finalizedAt && o.labelValue !== null ? isWin({ labelValue: o.labelValue }) : null;
}

/** Screened, shortlisted, decided trade or pass, and failed calls, since `since`. */
async function reviewCounts(since: Date) {
  const rows = await prisma.fdsaReview.groupBy({
    by: ["stage", "decision"],
    where: { createdAt: { gt: since } },
    _count: { _all: true },
    _sum: { costUsd: true },
  });
  const count = (stage: string, decision?: string | null) =>
    rows
      .filter((r) => r.stage === stage && (decision === undefined || r.decision === decision))
      .reduce((s, r) => s + r._count._all, 0);
  const screened = count("screen");
  const shortlisted = count("screen", "shortlist");
  return {
    screened,
    shortlisted,
    shortlistRate: screened > 0 ? shortlisted / screened : null,
    decided: count("decide"),
    trade: count("decide", "trade"),
    pass: count("decide", "pass"),
    revisions: count("revise"),
    failed: rows.filter((r) => r.decision === null).reduce((s, r) => s + r._count._all, 0),
    costUsd: Math.round(rows.reduce((s, r) => s + (r._sum.costUsd ?? 0), 0) * 100) / 100,
  };
}

/**
 * FDSA's record against the goal metric over the last `days` (see GET /record). Shared with the
 * public #fdsa page (routes/fdsaPublic.ts), which shows the rates and the ladder comparison but
 * not the prompt version or anything about spend.
 */
export async function fdsaRecord(days: number) {
  const since = new Date(Date.now() - days * DAY_MS);
  const [byVerdict, trades, ladder, latency] = await Promise.all([
    prisma.$queryRaw<
      {
        stage: string;
        decision: string | null;
        total: bigint;
        graded: bigint;
        wins: bigint;
        wins4x: bigint;
      }[]
    >`
      SELECT r."stage", r."decision", count(*) AS total,
             count(*) FILTER (WHERE ${GRADED}) AS graded,
             count(*) FILTER (WHERE ${WON}) AS wins,
             count(*) FILTER (WHERE ${WON_4X}) AS wins4x
      FROM "FdsaReview" r
      LEFT JOIN "CandidateOutcome" o ON o."id" = r."candidateOutcomeId"
      WHERE r."createdAt" > ${since} AND r."stage" IN ('screen', 'decide')
      GROUP BY r."stage", r."decision"`,
    prisma.$queryRaw<{ total: bigint; graded: bigint; wins: bigint; wins4x: bigint }[]>`
      SELECT count(*) AS total,
             count(*) FILTER (WHERE ${GRADED}) AS graded,
             count(*) FILTER (WHERE ${WON}) AS wins,
             count(*) FILTER (WHERE ${WON_4X}) AS wins4x
      FROM "FdsaPosition" p
      LEFT JOIN "CandidateOutcome" o ON o."id" = p."candidateOutcomeId"
      WHERE p."deskId" = ${FDSA_DESK_ID} AND p."openedAt" > ${since}`,
    prisma.fdsaPosition.findMany({
      where: { deskId: FDSA_DESK_ID, status: { not: "open" }, openedAt: { gt: since } },
      select: {
        swapInLamports: true,
        feesLamports: true,
        proceedsLamports: true,
        candidateOutcomeId: true,
      },
    }),
    prisma.$queryRaw<
      { n: bigint; verdict_p50: number | null; fill_p50: number | null; fill_p90: number | null }[]
    >`
      SELECT count(*) AS n,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM p."verdictAt" - p."signalAt") * 1000) AS verdict_p50,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM p."openedAt" - p."signalAt") * 1000) AS fill_p50,
             percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM p."openedAt" - p."signalAt") * 1000) AS fill_p90
      FROM "FdsaPosition" p
      WHERE p."deskId" = ${FDSA_DESK_ID} AND p."openedAt" > ${since}`,
  ]);

  const sum = (rows: typeof byVerdict) =>
    rate(
      rows.reduce((s, r) => s + num(r.total), 0),
      rows.reduce((s, r) => s + num(r.graded), 0),
      rows.reduce((s, r) => s + num(r.wins), 0),
      rows.reduce((s, r) => s + num(r.wins4x), 0),
    );
  const screen = byVerdict.filter((r) => r.stage === "screen");
  const decide = byVerdict.filter((r) => r.stage === "decide");
  const t = trades[0];

  // Paired: only closed trades whose alert has a ladder return. FDSA's is net of the paper fill
  // penalty and fees, from its own (later) fill; the ladder's is gross, from the alert price.
  const ladderOutcomes = await outcomesById(ladder.map((p) => p.candidateOutcomeId));
  const paired = ladder.flatMap((p) => {
    const sim = ladderOutcomes.get(p.candidateOutcomeId ?? "")?.simReturnPct;
    return sim === null || sim === undefined ? [] : [{ fdsa: pnl(p).pnlPct ?? 0, ladder: sim }];
  });
  const fdsaPct = paired.map((p) => p.fdsa);
  const ladderPct = paired.map((p) => p.ladder);
  const mean = (xs: number[]) => (xs.length > 0 ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
  const l = latency[0];

  return {
    days: days,
    promptVersion: FDSA_PROMPT_VERSION,
    // The pool: every alert FDSA screened, graded on the same label.
    pool: sum(screen),
    screen: {
      shortlisted: sum(screen.filter((r) => r.decision === "shortlist")),
      dropped: sum(screen.filter((r) => r.decision === "drop")),
      failed: sum(screen.filter((r) => r.decision === null)),
    },
    decide: {
      trade: sum(decide.filter((r) => r.decision === "trade")),
      pass: sum(decide.filter((r) => r.decision === "pass")),
      failed: sum(decide.filter((r) => r.decision === null)),
    },
    trades: rate(num(t?.total), num(t?.graded), num(t?.wins), num(t?.wins4x)),
    target: 0.75,
    ladder: {
      summary: describeExitPlan(EXIT_PLAN),
      closedTrades: ladder.length,
      paired: paired.length,
      fdsaAvgPct: mean(fdsaPct),
      ladderAvgPct: mean(ladderPct),
      fdsaBetter: paired.filter((_, i) => fdsaPct[i]! > ladderPct[i]!).length,
    },
    latency: {
      trades: num(l?.n),
      verdictP50Ms: l?.verdict_p50 ?? null,
      fillP50Ms: l?.fill_p50 ?? null,
      fillP90Ms: l?.fill_p90 ?? null,
    },
  };
}
