import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  BULK_EXTENSION_UNITS,
  MAX_BULK_EXTENSION,
  MAX_BULK_EXTENSION_DAYS,
  Prisma,
  bulkExtensionDays,
  prisma,
  walletTag,
} from "@trenchscanner/core";
import { requireAdminConfirmation } from "../tradeConfirm.js";

/**
 * Admin > Access: "Extend every subscription" (user ask 2026-11-27). Adds weeks or months to
 * every live subscription in one run, at most three months a run.
 *
 * Who it reaches: every Subscription whose expiresAt is still ahead. A lapsed subscription is not
 * revived, and whitelisted wallets, Free Access and admins have no expiry to move, so none of them
 * is touched. The panel says so before anything runs.
 *
 * The guards, because one press moves every paying user's expiry and can't be taken back short of
 * editing each row by hand:
 *   - a preview first, which the panel shows with the count and the days it adds;
 *   - the run must carry the admin's typed CONFIRM_WORD and the count the preview showed, and is
 *     refused if the count has moved since (someone subscribed or lapsed in between);
 *   - the admin wallet signs the exact request (requireAdminConfirmation, as for a model restore);
 *     a paired phone is let through without, per the 2026-10-18 decision;
 *   - each run has a requestId: a retry of the same request answers with the first run's result
 *     instead of adding the time again, and any other run within RUN_COOLDOWN_MS is refused, so
 *     two tabs or a double press can't stack two extensions by accident;
 *   - SubscriptionBulkExtension keeps who ran it, when, and what it did; AdminAction (the
 *     onResponse log) records every attempt, refused ones too.
 */

/** What the admin types to confirm, checked here as well as in the panel. */
export const EXTEND_ALL_CONFIRM_WORD = "EXTEND";
/** No second run this soon after one, unless it is the same request retried. */
export const RUN_COOLDOWN_MS = 10 * 60_000;
/** One key for the run itself, so two runs never interleave. */
const RUN_LOCK_KEY = "subscription-bulk-extension";

const amountSchema = z
  .object({
    unit: z.enum(BULK_EXTENSION_UNITS),
    amount: z.coerce.number().int().min(1),
  })
  .refine((v) => v.amount <= MAX_BULK_EXTENSION[v.unit], {
    message: `At most ${MAX_BULK_EXTENSION.weeks} weeks or ${MAX_BULK_EXTENSION.months} months at a time`,
  })
  .refine((v) => bulkExtensionDays(v.unit, v.amount) <= MAX_BULK_EXTENSION_DAYS, {
    message: `At most ${MAX_BULK_EXTENSION_DAYS} days at a time`,
  });

const runSchema = z.object({
  unit: z.enum(BULK_EXTENSION_UNITS),
  amount: z.number().int().min(1),
  /** The live count the preview showed; the run is refused if it no longer matches. */
  expectedUsers: z.number().int().min(0),
  confirmWord: z.string().max(40),
  requestId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/, "invalid request id"),
});

type Run = Prisma.SubscriptionBulkExtensionGetPayload<object>;

function runView(r: Run) {
  return {
    requestId: r.requestId,
    at: r.at,
    by: r.by,
    fromPhone: r.deviceId !== null,
    unit: r.unit,
    amount: r.amount,
    days: r.days,
    usersExtended: r.usersExtended,
  };
}

export async function registerAdminExtendAllRoutes(app: FastifyInstance) {
  /** What a run would do now: how many live subscriptions it reaches and the days it adds. */
  app.get("/subscriptions/extend-all/preview", async (request, reply) => {
    const parsed = amountSchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    }
    const { unit, amount } = parsed.data;
    const now = new Date();
    const [affected, range, lastRun] = await Promise.all([
      prisma.subscription.count({ where: { expiresAt: { gt: now } } }),
      prisma.subscription.aggregate({
        where: { expiresAt: { gt: now } },
        _min: { expiresAt: true },
        _max: { expiresAt: true },
      }),
      prisma.subscriptionBulkExtension.findFirst({ orderBy: { at: "desc" } }),
    ]);
    const days = bulkExtensionDays(unit, amount);
    const shift = (d: Date | null) => (d ? new Date(d.getTime() + days * 86_400_000) : null);
    const cooldownUntil =
      lastRun && now.getTime() - lastRun.at.getTime() < RUN_COOLDOWN_MS
        ? new Date(lastRun.at.getTime() + RUN_COOLDOWN_MS)
        : null;
    return {
      unit,
      amount,
      days,
      affected,
      // The soonest and latest expiry, before and after: enough to sanity-check the new dates.
      soonestExpiry: range._min.expiresAt,
      latestExpiry: range._max.expiresAt,
      soonestAfter: shift(range._min.expiresAt),
      latestAfter: shift(range._max.expiresAt),
      confirmWord: EXTEND_ALL_CONFIRM_WORD,
      lastRun: lastRun ? runView(lastRun) : null,
      cooldownUntil,
    };
  });

  /** Recent runs, newest first, for the panel's history. */
  app.get("/subscriptions/extend-all/runs", async () => {
    const runs = await prisma.subscriptionBulkExtension.findMany({ orderBy: { at: "desc" }, take: 20 });
    return runs.map(runView);
  });

  /** The run. See the guards above. */
  app.post(
    "/subscriptions/extend-all",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const parsed = runSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
      }
      const amountCheck = amountSchema.safeParse(parsed.data);
      if (!amountCheck.success) {
        return reply.code(400).send({ error: amountCheck.error.issues[0]?.message ?? "invalid request" });
      }
      const { unit, amount, expectedUsers, confirmWord, requestId } = parsed.data;
      if (confirmWord.trim() !== EXTEND_ALL_CONFIRM_WORD) {
        return reply.code(400).send({ error: `Type ${EXTEND_ALL_CONFIRM_WORD} to confirm.` });
      }
      if (!(await requireAdminConfirmation(request, reply))) return;

      const days = bulkExtensionDays(unit, amount);
      const by = request.user!.walletAddress;
      const deviceId = request.user!.deviceId ?? null;

      type Outcome =
        | { kind: "done"; run: Run }
        | { kind: "replayed"; run: Run }
        | { kind: "cooldown"; run: Run }
        | { kind: "moved"; affected: number };

      const outcome = await prisma.$transaction(
        async (tx): Promise<Outcome> => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${RUN_LOCK_KEY}))`;
          const same = await tx.subscriptionBulkExtension.findUnique({ where: { requestId } });
          if (same) return { kind: "replayed", run: same };
          const last = await tx.subscriptionBulkExtension.findFirst({ orderBy: { at: "desc" } });
          if (last && Date.now() - last.at.getTime() < RUN_COOLDOWN_MS)
            return { kind: "cooldown", run: last };

          const now = new Date();
          const live = await tx.subscription.findMany({
            where: { expiresAt: { gt: now } },
            select: { userId: true },
            orderBy: { userId: "asc" },
          });
          if (live.length !== expectedUsers) return { kind: "moved", affected: live.length };
          const ids = live.map((s) => s.userId);
          if (ids.length > 0) {
            // The per-user lock a burn credit, a held-burn claim and the single grant take before
            // they read an expiry (subscription/access.ts): without it, one of those landing
            // mid-run would write back an expiry read before this run and drop the extension.
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(id)) FROM unnest(${ids}::text[]) AS id`;
            // Re-checked on the row: a subscription that lapsed in the last moment is left alone.
            await tx.$executeRaw`
              UPDATE "Subscription"
              SET "expiresAt" = "expiresAt" + make_interval(days => ${days}::int), "updatedAt" = now()
              WHERE "userId" = ANY(${ids}::text[]) AND "expiresAt" > ${now}`;
          }
          const run = await tx.subscriptionBulkExtension.create({
            data: { requestId, by, deviceId, unit, amount, days, usersExtended: ids.length },
          });
          return { kind: "done", run };
        },
        // Many users' locks and one UPDATE: more than the default 5 seconds on a busy database.
        { timeout: 60_000, maxWait: 10_000 },
      );

      if (outcome.kind === "moved") {
        return reply.code(409).send({
          error: `The number of live subscriptions changed to ${outcome.affected} since you reviewed it. Review it again.`,
          affected: outcome.affected,
        });
      }
      if (outcome.kind === "cooldown") {
        return reply.code(409).send({
          error: `Every subscription was already extended ${Math.max(
            1,
            Math.round((Date.now() - outcome.run.at.getTime()) / 60_000),
          )} min ago. Wait ${RUN_COOLDOWN_MS / 60_000} minutes between runs.`,
          lastRun: runView(outcome.run),
        });
      }
      if (outcome.kind === "done") {
        request.log.info(
          { by: walletTag(by), unit, amount, days, users: outcome.run.usersExtended },
          "extended every live subscription",
        );
      }
      return { ...runView(outcome.run), replayed: outcome.kind === "replayed" };
    },
  );
}
