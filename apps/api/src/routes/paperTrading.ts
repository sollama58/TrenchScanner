import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import {
  DEFAULT_PAPER_BANKROLL_SOL,
  DEFAULT_PAPER_CONFIG,
  describeExitPlan,
  effectiveExitPlan,
  enabledContestants,
  EXIT_PLAN,
  MAX_PAPER_STRATEGIES,
  MAX_RUNNING_PAPER_STRATEGIES,
  paperSignalVerdicts,
  paperStats,
  paperStrategyConfigSchema,
  prisma,
  readExitPlan,
  readPaperConfig,
  solToLamports,
  type Env,
  type PaperStrategyConfig,
} from "@trenchscanner/core";

/**
 * Admin -> Trading bot -> Paper trading: each admin's own simulated strategies (see
 * packages/core/src/trading/paper.ts). Nothing here touches a wallet or funds, so these routes are
 * registered whether or not the real bot is on. Admins only; an admin keeps up to
 * MAX_PAPER_STRATEGIES and runs up to MAX_RUNNING_PAPER_STRATEGIES at once.
 */

const MAX_POSITIONS_SHOWN = 50;

const nameSchema = z.string().trim().min(1).max(60);
const bankrollSchema = z.number().positive().max(1_000_000);

const createSchema = z.object({
  name: nameSchema.optional(),
  config: paperStrategyConfigSchema.optional(),
  bankrollSol: bankrollSchema.optional(),
  /** Start from another of your strategies' settings. */
  copyFrom: z.string().min(1).max(64).optional(),
});
const patchSchema = z.object({
  name: nameSchema.optional(),
  config: paperStrategyConfigSchema.optional(),
  running: z.boolean().optional(),
});
const resetSchema = z.object({ bankrollSol: bankrollSchema.optional() });

const lamports = (v: bigint) => v.toString();

function badRequest(reply: FastifyReply, error: z.ZodError) {
  const issue = error.issues[0];
  return reply
    .code(400)
    .send({ error: issue ? `${issue.path.join(".")}: ${issue.message}` : "invalid request" });
}

export async function registerPaperTradingRoutes(
  app: FastifyInstance,
  { env, admins }: { env: Env; admins: Set<string> },
) {
  const models = enabledContestants(env.CURATOR_CONTESTANTS).map((c) => ({ id: c.id, name: c.name }));
  const isAdmin = (request: FastifyRequest) => admins.has(request.user!.walletAddress);

  /** Keeps only the sources this admin may follow: their own filters, and models on this deployment. */
  async function sanitize(userId: string, config: PaperStrategyConfig): Promise<PaperStrategyConfig> {
    const own = await prisma.userFilter.findMany({ where: { userId }, select: { id: true } });
    const allowed = new Set(own.map((f) => f.id));
    const known = new Set(models.map((m) => m.id));
    return {
      ...config,
      sources: {
        ...config.sources,
        filterIds: config.sources.filterIds.filter((id) => allowed.has(id)),
        models: config.sources.models.filter((id) => known.has(id)),
      },
    };
  }

  /** The admin's strategy, or a 404 sent. */
  async function owned(request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    const strategy = await prisma.paperStrategy.findFirst({
      where: { id: request.params.id, userId: request.user!.userId },
    });
    if (!strategy) void reply.code(404).send({ error: "no paper strategy with that id" });
    return strategy;
  }

  app.addHook("preHandler", async (request, reply) => {
    if (!isAdmin(request)) return reply.code(403).send({ error: "forbidden" });
  });

  app.get("/", async (request) => {
    const { userId } = request.user!;
    const [strategies, filters] = await Promise.all([
      prisma.paperStrategy.findMany({ where: { userId }, orderBy: { createdAt: "asc" } }),
      prisma.userFilter.findMany({
        where: { userId },
        select: { id: true, name: true, isActive: true, armedAt: true },
        orderBy: { createdAt: "asc" },
      }),
    ]);
    const ids = strategies.map((s) => s.id);
    // Every position counts toward the results; the latest few are shown, with their fills.
    const [all, shown] = await Promise.all([
      prisma.paperPosition.findMany({
        where: { strategyId: { in: ids } },
        select: {
          id: true,
          strategyId: true,
          status: true,
          swapInLamports: true,
          feesLamports: true,
          proceedsLamports: true,
          tokensBought: true,
          tokensHeld: true,
          lastMultiple: true,
        },
      }),
      Promise.all(
        ids.map((strategyId) =>
          prisma.paperPosition.findMany({
            where: { strategyId },
            orderBy: { createdAt: "desc" },
            take: MAX_POSITIONS_SHOWN,
            include: { fills: { orderBy: { createdAt: "asc" } } },
          }),
        ),
      ),
    ]);
    // Hit 2x is graded on each signal's own verdict, as every other hit rate is.
    const verdicts = await paperSignalVerdicts(all.map((p) => p.id));
    return {
      maxRunning: MAX_RUNNING_PAPER_STRATEGIES,
      maxStrategies: MAX_PAPER_STRATEGIES,
      defaults: {
        config: DEFAULT_PAPER_CONFIG,
        bankrollSol: DEFAULT_PAPER_BANKROLL_SOL,
        exitPlan: EXIT_PLAN,
        exitPlanSummary: describeExitPlan(EXIT_PLAN),
      },
      sources: {
        filters: filters.map((f) => ({ id: f.id, name: f.name, isActive: f.isActive, armedAt: f.armedAt })),
        models,
      },
      strategies: strategies.map((s, i) => {
        const config = readPaperConfig(s.config);
        const stats = paperStats(
          s,
          all.filter((p) => p.strategyId === s.id).map((p) => ({ ...p, hit2x: verdicts.get(p.id) ?? null })),
        );
        return {
          id: s.id,
          name: s.name,
          running: s.running,
          config,
          exitPlanSummary: describeExitPlan(effectiveExitPlan(config)),
          bankrollLamports: lamports(s.bankrollLamports),
          cashLamports: lamports(s.cashLamports),
          lastRunAt: s.lastRunAt,
          lastError: s.lastError,
          resetAt: s.resetAt,
          createdAt: s.createdAt,
          recentSkips: Array.isArray(s.recentSkips) ? s.recentSkips : [],
          changedFilters: filters
            .filter((f) => config.sources.filterIds.includes(f.id) && f.armedAt > s.configSavedAt)
            .map((f) => f.id),
          stats: {
            ...stats,
            equityLamports: lamports(stats.equityLamports),
            openValueLamports: lamports(stats.openValueLamports),
            pnlLamports: lamports(stats.pnlLamports),
          },
          positions: shown[i]!.map((p) => ({
            id: p.id,
            mint: p.mint,
            symbol: p.symbol,
            source: p.sourceLabel,
            signalAt: p.signalAt,
            status: p.status,
            swapInLamports: lamports(p.swapInLamports),
            feesLamports: lamports(p.feesLamports),
            proceedsLamports: lamports(p.proceedsLamports),
            tokensBought: p.tokensBought,
            tokensHeld: p.tokensHeld,
            rungsTaken: p.rungsTaken,
            lastMultiple: p.lastMultiple,
            lastPricedAt: p.lastPricedAt,
            peakMultiple: p.peakMultiple,
            openedAt: p.openedAt,
            closedAt: p.closedAt,
            closeReason: p.closeReason,
            closeRequested: p.closeRequested,
            error: p.error,
            exitPlanSummary: describeExitPlan(readExitPlan(p.exitPlan)),
            fills: p.fills.map((f) => ({
              side: f.side,
              reason: f.reason,
              lamports: lamports(f.lamports),
              feeLamports: lamports(f.feeLamports),
              multiple: f.multiple,
              createdAt: f.createdAt,
            })),
          })),
        };
      }),
    };
  });

  app.post("/", async (request, reply) => {
    const parsed = createSchema.safeParse(request.body ?? {});
    if (!parsed.success) return badRequest(reply, parsed.error);
    const { userId } = request.user!;
    let config = parsed.data.config ?? DEFAULT_PAPER_CONFIG;
    if (parsed.data.copyFrom) {
      const source = await prisma.paperStrategy.findFirst({ where: { id: parsed.data.copyFrom, userId } });
      if (!source) return reply.code(404).send({ error: "no paper strategy to copy" });
      config = readPaperConfig(source.config);
    }
    config = await sanitize(userId, config);
    const bankroll = solToLamports(parsed.data.bankrollSol ?? DEFAULT_PAPER_BANKROLL_SOL);
    // Counted under the account's row lock, so two clicks can't both pass the limit.
    const created = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
      const count = await tx.paperStrategy.count({ where: { userId } });
      if (count >= MAX_PAPER_STRATEGIES) return null;
      return tx.paperStrategy.create({
        data: {
          userId,
          name: parsed.data.name ?? `Strategy ${count + 1}`,
          config: config as unknown as Prisma.InputJsonValue,
          bankrollLamports: bankroll,
          cashLamports: bankroll,
        },
      });
    });
    if (!created) {
      return reply
        .code(409)
        .send({ error: `at most ${MAX_PAPER_STRATEGIES} paper strategies; delete one first` });
    }
    return { id: created.id };
  });

  app.patch<{ Params: { id: string } }>("/:id", async (request, reply) => {
    const parsed = patchSchema.safeParse(request.body ?? {});
    if (!parsed.success) return badRequest(reply, parsed.error);
    const strategy = await owned(request, reply);
    if (!strategy) return;
    const { userId } = request.user!;
    const config = parsed.data.config ? await sanitize(userId, parsed.data.config) : null;
    const starting = parsed.data.running === true && !strategy.running;
    const now = new Date();
    const data = {
      ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
      ...(parsed.data.running !== undefined ? { running: parsed.data.running } : {}),
      // Starting reads signals from now: a strategy never buys a backlog.
      ...(starting ? { signalsFrom: now, lossWindowFrom: now, lastError: null } : {}),
      ...(config ? { config: config as unknown as Prisma.InputJsonValue, configSavedAt: now } : {}),
    };
    const updated = await prisma.$transaction(async (tx) => {
      if (starting) {
        await tx.$queryRaw`SELECT 1 FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
        const running = await tx.paperStrategy.count({
          where: { userId, running: true, id: { not: strategy.id } },
        });
        if (running >= MAX_RUNNING_PAPER_STRATEGIES) return null;
      }
      return tx.paperStrategy.update({ where: { id: strategy.id }, data });
    });
    if (!updated) {
      return reply.code(409).send({
        error: `at most ${MAX_RUNNING_PAPER_STRATEGIES} paper strategies run at once; stop one first`,
      });
    }
    return { id: updated.id, running: updated.running, config: readPaperConfig(updated.config) };
  });

  /** Back to a full bankroll: its positions and history are dropped. */
  app.post<{ Params: { id: string } }>("/:id/reset", async (request, reply) => {
    const parsed = resetSchema.safeParse(request.body ?? {});
    if (!parsed.success) return badRequest(reply, parsed.error);
    const strategy = await owned(request, reply);
    if (!strategy) return;
    const bankroll =
      parsed.data.bankrollSol !== undefined
        ? solToLamports(parsed.data.bankrollSol)
        : strategy.bankrollLamports;
    const now = new Date();
    await prisma.$transaction([
      prisma.paperPosition.deleteMany({ where: { strategyId: strategy.id } }),
      prisma.paperStrategy.update({
        where: { id: strategy.id },
        data: {
          bankrollLamports: bankroll,
          cashLamports: bankroll,
          resetAt: now,
          signalsFrom: now,
          lossWindowFrom: now,
          recentSkips: [],
          lastError: null,
        },
      }),
    ]);
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>("/:id", async (request, reply) => {
    const strategy = await owned(request, reply);
    if (!strategy) return;
    await prisma.paperStrategy.delete({ where: { id: strategy.id } });
    return { ok: true };
  });

  app.post<{ Params: { id: string; positionId: string } }>(
    "/:id/positions/:positionId/close",
    async (request, reply) => {
      const strategy = await owned(request, reply);
      if (!strategy) return;
      const updated = await prisma.paperPosition.updateMany({
        where: { id: request.params.positionId, strategyId: strategy.id, status: "open" },
        data: { closeRequested: true },
      });
      if (updated.count === 0) return reply.code(404).send({ error: "no open position with that id" });
      return { ok: true };
    },
  );

  /** Stops buying and sells every open position on the next pass. */
  app.post<{ Params: { id: string } }>("/:id/close-all", async (request, reply) => {
    const strategy = await owned(request, reply);
    if (!strategy) return;
    await prisma.paperStrategy.update({ where: { id: strategy.id }, data: { running: false } });
    const updated = await prisma.paperPosition.updateMany({
      where: { strategyId: strategy.id, status: "open" },
      data: { closeRequested: true },
    });
    return { ok: true, positions: updated.count };
  });
}
