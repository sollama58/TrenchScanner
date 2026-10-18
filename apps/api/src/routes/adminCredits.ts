import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  burnCreditPrices,
  creditsOfRaw,
  CreditGrantError,
  grantCredits,
  prisma,
  saveBurnCreditPrices,
  walletTag,
} from "@trenchscanner/core";

/**
 * Burn Credits in the Admin tab (routes registered behind authenticateAdmin, under /admin):
 * - GET  /admin/credits          the prices, the totals, and the newest ledger rows
 * - PUT  /admin/credits/settings the ratio (whole $ASDFASDFA per credit) and each utility's cost
 * - POST /admin/credits/grant    add (or, negative, take back) credits by hand
 */

const ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const settingsSchema = z.object({
  tokensPerCredit: z.number().int().min(1).max(1_000_000_000),
  cost: z.object({
    token: z.number().int().min(0).max(1_000),
    wallet: z.number().int().min(0).max(1_000),
  }),
});

const grantSchema = z.object({
  wallet: z.string().regex(ADDRESS_RE, "not a Solana address"),
  delta: z
    .number()
    .int()
    .min(-100_000)
    .max(100_000)
    .refine((n) => n !== 0, "enter a number of credits other than 0"),
  note: z.string().trim().max(200).optional(),
});

export async function registerAdminCreditRoutes(app: FastifyInstance) {
  app.get("/credits", async () => {
    const [prices, byKind, counts, wallets, recent, pot] = await Promise.all([
      burnCreditPrices(),
      prisma.burnCreditEntry.groupBy({ by: ["kind", "source"], _sum: { delta: true } }),
      // Lookups, not rows: one that drew on two pots of credits is a row per pot at the same time.
      prisma.$queryRaw<{ burns: bigint; lookups: bigint }[]>`
        SELECT COUNT(*) FILTER (WHERE "kind" = 'burn') AS burns,
               COUNT(DISTINCT ("wallet", "utility", "subject", "createdAt")) FILTER (WHERE "kind" = 'spend') AS lookups
        FROM "BurnCreditEntry"`,
      // Counted in SQL: Prisma's `distinct` runs in memory here (no nativeDistinct), which read
      // every ledger row into the API on each load.
      prisma.$queryRaw<{ n: bigint }[]>`SELECT COUNT(DISTINCT "wallet") AS n FROM "BurnCreditEntry"`,
      prisma.burnCreditEntry.findMany({
        orderBy: { createdAt: "desc" },
        take: 50,
        select: {
          wallet: true,
          delta: true,
          kind: true,
          burnSignature: true,
          rawAmount: true,
          utility: true,
          subject: true,
          note: true,
          source: true,
          asdfRaw: true,
          createdAt: true,
        },
      }),
      // The burned pot is held in ASDF (credits.ts creditPots): its credits at today's price.
      prisma.burnCreditEntry.aggregate({ where: { source: "burned" }, _sum: { asdfRaw: true } }),
    ]);
    const sum = (kind: string, daily = false) =>
      byKind
        .filter((k) => k.kind === kind && (k.source === "daily") === daily)
        .reduce((n, k) => n + (k._sum.delta ?? 0), 0);
    return {
      prices,
      totals: {
        wallets: Number(wallets[0]?.n ?? 0),
        burns: Number(counts[0]?.burns ?? 0),
        earned: sum("burn"),
        granted: sum("grant"),
        lookups: Number(counts[0]?.lookups ?? 0),
        spent: -sum("spend"),
        // Subscribers' free daily credits used: not part of any balance, so not in `outstanding`.
        dailyFreeUsed: -sum("spend", true),
        // Unspent granted credits plus the burned pot (held in ASDF) at the current price.
        outstanding:
          Math.round(
            (byKind.filter((k) => k.source === "granted").reduce((n, k) => n + (k._sum.delta ?? 0), 0) +
              creditsOfRaw(pot._sum.asdfRaw ?? 0n, prices.tokensPerCredit)) *
              100,
          ) / 100,
        burnedRaw: (pot._sum.asdfRaw ?? 0n).toString(),
      },
      recent: recent.map((r) => ({ ...r, asdfRaw: r.asdfRaw?.toString() ?? null })),
    };
  });

  app.put("/credits/settings", async (request, reply) => {
    const parsed = settingsSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    }
    const prices = await saveBurnCreditPrices(parsed.data, request.user!.walletAddress);
    request.log.info({ prices, by: walletTag(request.user!.walletAddress) }, "burn credit prices changed");
    return { prices };
  });

  app.post("/credits/grant", async (request, reply) => {
    const parsed = grantSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    }
    const { wallet, delta, note } = parsed.data;
    const by = request.user!.walletAddress;
    let balance: number;
    try {
      balance = await grantCredits(wallet, delta, note ? `${note} (by ${by})` : `by ${by}`);
    } catch (err) {
      if (err instanceof CreditGrantError) return reply.code(409).send({ error: err.message });
      throw err;
    }
    request.log.info({ wallet: walletTag(wallet), delta, by: walletTag(by) }, "granted burn credits by hand");
    return { wallet, balance };
  });
}
