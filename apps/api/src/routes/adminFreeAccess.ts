import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  adminWalletSet,
  currentFreeAccessPeriod,
  deleteDigest,
  disableFreeAccess,
  freeAccessCleanupAt,
  freeAccessPhase,
  planFreeAccessCleanup,
  prisma,
  saveFreeAccessPeriod,
  type Env,
  type FreeAccessPeriod,
  type FreeAccessPlanEntry,
  walletTag,
} from "@trenchscanner/core";

/**
 * Admin > Access > Free Access (packages/core/src/subscription/freeAccess.ts): set a period when
 * any wallet that signs in gets full access, switch it off, and see beforehand what the cleanup at
 * its end will delete. Behind the admin wallet check (registered under its preHandler in
 * server.ts). Both writes need `confirm: true`; the switch-off also the digest of the plan the
 * admin was shown, and is refused when the accounts it would delete have changed since.
 */

/** Plan rows sent to the panel; the counts and the digest cover every row. */
const PLAN_ROWS = 500;

const saveSchema = z.object({
  signInStartsAt: z.coerce.date(),
  signInEndsAt: z.coerce.date(),
  accessEndsAt: z.coerce.date(),
  confirm: z.literal(true),
});

const disableSchema = z.object({
  confirm: z.literal(true),
  /** The digest of the plan the admin confirmed (GET /free-access's plan.digest). */
  digest: z.string().min(1).max(64),
});

function summarize(plan: readonly FreeAccessPlanEntry[]) {
  const kept: Record<string, number> = {};
  for (const p of plan) if (p.reason !== null) kept[p.reason] = (kept[p.reason] ?? 0) + 1;
  return {
    enrolled: plan.length,
    deletes: plan.filter((p) => p.action === "delete").length,
    keeps: plan.filter((p) => p.action === "keep").length,
    kept,
    digest: deleteDigest(plan),
    rows: plan.slice(0, PLAN_ROWS),
  };
}

const withPhase = (period: FreeAccessPeriod, now = new Date()) => ({
  ...period,
  phase: freeAccessPhase(period, now),
  cleanupAt: freeAccessCleanupAt(period),
});

export async function registerAdminFreeAccessRoutes(app: FastifyInstance, { env }: { env: Env }) {
  const admins = adminWalletSet(env);

  app.get("/free-access", async () => {
    const now = new Date();
    const [period, history] = await Promise.all([
      currentFreeAccessPeriod(),
      prisma.freeAccessPeriod.findMany({
        where: { purgedAt: { not: null } },
        orderBy: { purgedAt: "desc" },
        take: 10,
      }),
    ]);
    const outcomes = await prisma.freeAccessGrant.groupBy({
      by: ["periodId", "outcome"],
      where: { periodId: { in: history.map((h) => h.id) } },
      _count: { _all: true },
    });
    const plan = period ? summarize(await planFreeAccessCleanup(period.id, admins, now)) : null;
    return {
      now,
      period: period ? withPhase(period, now) : null,
      plan,
      history: history.map((h) => {
        const mine = outcomes.filter((o) => o.periodId === h.id);
        return {
          ...h,
          enrolled: mine.reduce((sum, o) => sum + o._count._all, 0),
          deleted: mine.find((o) => o.outcome === "deleted")?._count._all ?? 0,
        };
      }),
    };
  });

  /** Switch Free Access on with these times, or change the times of the period that is on. */
  app.put("/free-access", async (request, reply) => {
    const parsed = saveSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    }
    const { confirm: _confirm, ...times } = parsed.data;
    const by = request.user!.walletAddress;
    const result = await saveFreeAccessPeriod(times, by);
    if (!result.ok) return reply.code(409).send({ error: result.error });
    request.log.info({ ...times, by: walletTag(by), created: result.created }, "free access set");
    return { period: withPhase(result.period) };
  });

  /**
   * Switch Free Access off now: every enrolled wallet loses it at once, and the worker runs the
   * cleanup after the grace (freeAccessCleanupAt). Refused when the accounts it would delete are
   * no longer the ones the admin was shown.
   */
  app.post("/free-access/disable", async (request, reply) => {
    const parsed = disableSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    }
    const by = request.user!.walletAddress;
    const result = await disableFreeAccess(by, admins, parsed.data.digest);
    if (!result.ok) return reply.code(409).send({ error: result.error, deletes: result.deletes });
    request.log.info({ periodId: result.period.id, by: walletTag(by) }, "free access switched off");
    return { period: withPhase(result.period) };
  });
}
