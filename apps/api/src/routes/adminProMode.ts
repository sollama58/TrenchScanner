import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  adminWalletSet,
  asdfPriceGuards,
  isWalletAddress,
  prisma,
  proHolderSummary,
  PRO_HOLDER_COUNT,
  sacrificeSettings,
  saveSacrificeSettings,
  smoothedAsdfPerSol,
  SUBSCRIPTION_MINT_DECIMALS,
  type Env,
  walletTag,
} from "@trenchscanner/core";
import { forgetProStatus } from "../proMode.js";

/**
 * Admin > Access > Pro Mode: which wallets see the token modal's Trade panel (proMode.ts). The
 * admins have it always and are listed for completeness; the top 250 $ASDFASDFA holders have it
 * from the holder scan (counted, with who is in their 24-hour grace); anyone else is a
 * ProModeGrant row, added or removed here, with an optional end date. Registered inside the admin
 * block (authenticateAdmin), so each change also lands in the admin action log.
 */

const grantSchema = z.object({
  walletAddress: z.string().trim().refine(isWalletAddress, "not a wallet address"),
  note: z.string().trim().max(200).optional(),
  /** Days until it ends; left out for no end date. */
  days: z.number().int().min(1).max(3650).optional(),
});

const sacrificeSchema = z.object({
  mode: z.enum(["off", "shadow", "on"]),
  freeRank: z.number().int().min(1).max(PRO_HOLDER_COUNT),
});

export async function registerAdminProModeRoutes(app: FastifyInstance, opts: { env: Env }) {
  // The Sacrifice on Admin > Pro Mode (sacrifice.ts): its mode and free cut-off, and the ASDF
  // price it is charged at (asdfPrice.ts) with each source's spot price and the guard state.
  // While the Sacrifice is off the worker samples every minute, not every 15 seconds, so the
  // guards shown are the slower cadence's (user ask 2026-10-23: API audit bundle).
  app.get("/pro-mode/sacrifice", async () => {
    const settings = await sacrificeSettings();
    const price = await smoothedAsdfPerSol(new Date(), asdfPriceGuards(settings.mode));
    return { settings, price };
  });

  app.put("/pro-mode/sacrifice", async (request, reply) => {
    const parsed = sacrificeSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    }
    const by = request.user!.walletAddress;
    const settings = await saveSacrificeSettings(parsed.data, by);
    request.log.info({ settings, by: walletTag(by) }, "sacrifice settings changed");
    return { settings };
  });

  app.get("/pro-mode", async () => {
    const [grants, holders] = await Promise.all([
      prisma.proModeGrant.findMany({ orderBy: { createdAt: "desc" } }),
      proHolderSummary(),
    ]);
    const users = await prisma.user.findMany({
      where: {
        walletAddress: {
          in: [
            ...grants.map((g) => g.walletAddress),
            ...holders.top.map((h) => h.walletAddress),
            ...holders.grace.map((g) => g.walletAddress),
          ],
        },
      },
      select: { walletAddress: true },
    });
    const signedUp = new Set(users.map((u) => u.walletAddress));
    return {
      enabled: opts.env.PRO_TRADING_ENABLED,
      /** False: admins only; grants and holders are listed but get no Trade panel yet. */
      public: opts.env.PRO_TRADING_PUBLIC,
      admins: [...adminWalletSet(opts.env)],
      // The top 250 $ASDFASDFA holders' Pro Mode: the newest scan, and who is in their grace period.
      // Each holder marked with whether it has an account here: Pro Mode shows only to those.
      holders: {
        ...holders,
        decimals: SUBSCRIPTION_MINT_DECIMALS,
        top: holders.top.map((h) => ({ ...h, signedUp: signedUp.has(h.walletAddress) })),
        grace: holders.grace.map((g) => ({ ...g, signedUp: signedUp.has(g.walletAddress) })),
      },
      grants: grants.map((g) => ({ ...g, signedUp: signedUp.has(g.walletAddress) })),
    };
  });

  app.post("/pro-mode", async (request, reply) => {
    const parsed = grantSchema.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    const { walletAddress, note, days } = parsed.data;
    const expiresAt = days ? new Date(Date.now() + days * 24 * 60 * 60_000) : null;
    // A re-grant is a new grant: who gave it, its note and its end date all replace the old ones.
    const fields = { note: note || null, grantedBy: request.user!.walletAddress, expiresAt };
    const grant = await prisma.proModeGrant.upsert({
      where: { walletAddress },
      update: { ...fields, createdAt: new Date() },
      create: { walletAddress, ...fields },
    });
    forgetProStatus(walletAddress);
    request.log.info(
      { wallet: walletTag(walletAddress), by: walletTag(request.user!.walletAddress), days: days ?? null },
      "granted Pro Mode",
    );
    return grant;
  });

  app.delete<{ Params: { walletAddress: string } }>("/pro-mode/:walletAddress", async (request) => {
    const { walletAddress } = request.params;
    const result = await prisma.proModeGrant.deleteMany({ where: { walletAddress } });
    forgetProStatus(walletAddress);
    request.log.info(
      { wallet: walletTag(walletAddress), by: walletTag(request.user!.walletAddress) },
      "removed Pro Mode",
    );
    return { ok: true, removed: result.count > 0 };
  });
}
