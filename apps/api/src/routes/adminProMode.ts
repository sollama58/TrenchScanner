import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  adminWalletSet,
  looksLikeSolanaAddress,
  prisma,
  proHolderSummary,
  type Env,
} from "@trenchscanner/core";
import { walletTag } from "../walletTag.js";

/**
 * Admin > Access > Pro Mode: which wallets see the token modal's Trade panel (proMode.ts). The
 * admins have it always and are listed for completeness; the top 250 $ASDFASDFA holders have it
 * from the holder scan (counted, with who is in their 24-hour grace); anyone else is a
 * ProModeGrant row, added or removed here. Registered inside the admin block (authenticateAdmin).
 */

const grantSchema = z.object({
  walletAddress: z.string().trim().refine(looksLikeSolanaAddress, "not a wallet address"),
  note: z.string().trim().max(200).optional(),
});

export async function registerAdminProModeRoutes(app: FastifyInstance, opts: { env: Env }) {
  app.get("/pro-mode", async () => {
    const grants = await prisma.proModeGrant.findMany({ orderBy: { createdAt: "desc" } });
    const users = await prisma.user.findMany({
      where: { walletAddress: { in: grants.map((g) => g.walletAddress) } },
      select: { walletAddress: true },
    });
    const signedUp = new Set(users.map((u) => u.walletAddress));
    return {
      enabled: opts.env.PRO_TRADING_ENABLED,
      admins: [...adminWalletSet(opts.env)],
      // The top 250 $ASDFASDFA holders' Pro Mode: the newest scan, and who is in their grace period.
      holders: await proHolderSummary(),
      grants: grants.map((g) => ({ ...g, signedUp: signedUp.has(g.walletAddress) })),
    };
  });

  app.post("/pro-mode", async (request, reply) => {
    const parsed = grantSchema.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    const { walletAddress, note } = parsed.data;
    const grant = await prisma.proModeGrant.upsert({
      where: { walletAddress },
      update: { note: note || null },
      create: { walletAddress, note: note || null, grantedBy: request.user!.walletAddress },
    });
    request.log.info(
      { wallet: walletTag(walletAddress), by: walletTag(request.user!.walletAddress) },
      "granted Pro Mode",
    );
    return grant;
  });

  app.delete<{ Params: { walletAddress: string } }>("/pro-mode/:walletAddress", async (request) => {
    const { walletAddress } = request.params;
    const result = await prisma.proModeGrant.deleteMany({ where: { walletAddress } });
    request.log.info(
      { wallet: walletTag(walletAddress), by: walletTag(request.user!.walletAddress) },
      "removed Pro Mode",
    );
    return { ok: true, removed: result.count > 0 };
  });
}
