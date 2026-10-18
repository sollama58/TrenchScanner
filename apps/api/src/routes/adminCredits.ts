import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { burnCreditPrices, grantCredits, prisma, saveBurnCreditPrices } from "@trenchscanner/core";

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
    const [prices, byKind, wallets, recent] = await Promise.all([
      burnCreditPrices(),
      prisma.burnCreditEntry.groupBy({ by: ["kind"], _sum: { delta: true }, _count: { _all: true } }),
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
          createdAt: true,
        },
      }),
    ]);
    const sum = (kind: string) => byKind.find((k) => k.kind === kind)?._sum.delta ?? 0;
    const count = (kind: string) => byKind.find((k) => k.kind === kind)?._count._all ?? 0;
    return {
      prices,
      totals: {
        wallets: Number(wallets[0]?.n ?? 0),
        burns: count("burn"),
        earned: sum("burn"),
        granted: sum("grant"),
        lookups: count("spend"),
        spent: -sum("spend"),
        outstanding: sum("burn") + sum("grant") + sum("spend"),
      },
      recent,
    };
  });

  app.put("/credits/settings", async (request, reply) => {
    const parsed = settingsSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    }
    const prices = await saveBurnCreditPrices(parsed.data, request.user!.walletAddress);
    request.log.info({ prices, by: request.user!.walletAddress }, "burn credit prices changed");
    return { prices };
  });

  app.post("/credits/grant", async (request, reply) => {
    const parsed = grantSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    }
    const { wallet, delta, note } = parsed.data;
    const by = request.user!.walletAddress;
    const balance = await grantCredits(wallet, delta, note ? `${note} (by ${by})` : `by ${by}`);
    request.log.info({ wallet, delta, by }, "granted burn credits by hand");
    return { wallet, balance };
  });
}
