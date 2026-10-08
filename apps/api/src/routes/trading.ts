import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import {
  adminWalletSet,
  createKeyProvider,
  describeExitPlan,
  effectiveExitPlan,
  enabledContestants,
  ensureTradingWallet,
  EXIT_PLAN,
  LAMPORTS_PER_SOL,
  prisma,
  readExitPlan,
  readTradingBotConfig,
  RENT_EXEMPT_MIN_LAMPORTS,
  TradingRpc,
  tradingBotConfigSchema,
  type Env,
} from "@trenchscanner/core";

/**
 * The trading bot's tab (admin-only while it is new): the user's custodial wallet, the bot's
 * settings, its positions, and withdrawals.
 *
 * Who may do what:
 *   - creating a wallet and changing the bot: admins (ADMIN_WALLET_ADDRESSES) only;
 *   - seeing the wallet, selling positions and withdrawing: anyone who HAS a wallet, so an admin
 *     who is later removed can still get their money out.
 *
 * Withdrawals go to the wallet the session signed in with, and nowhere else: the destination is
 * read from the user's row, never from the request, so a stolen session can at worst send the
 * owner's funds back to the owner. The api never opens a wallet's key - it only records the
 * request; the worker, the one process allowed to decrypt (kms:Decrypt), sends it.
 *
 * With TRADING_BOT_ENABLED off nothing here is registered and every route answers 404.
 */

const MAX_POSITIONS_SHOWN = 100;

const withdrawSchema = z.object({
  /** Lamports as a decimal string, or "max" for everything less the fee. */
  amount: z.union([z.literal("max"), z.string().regex(/^\d{1,19}$/)]),
});

const botPatchSchema = z.object({
  enabled: z.boolean().optional(),
  config: tradingBotConfigSchema.optional(),
});

function lamportsJson(v: bigint | null | undefined): string | null {
  return v === null || v === undefined ? null : v.toString();
}

export async function registerTradingRoutes(app: FastifyInstance, { env }: { env: Env }) {
  if (!env.TRADING_BOT_ENABLED) return;
  const admins = adminWalletSet(env);
  const keys = createKeyProvider({ ...env, NODE_ENV: process.env.NODE_ENV });
  const rpc = new TradingRpc({
    rpcUrl: env.SOLANA_RPC_URL || undefined,
    apiKey: env.HELIUS_API_KEY || undefined,
  });
  const models = enabledContestants(env.CURATOR_CONTESTANTS).map((c) => ({ id: c.id, name: c.name }));

  app.addHook("preHandler", app.authenticate);

  const isAdmin = (request: FastifyRequest) => admins.has(request.user!.walletAddress);
  const requireAdmin = (request: FastifyRequest, reply: FastifyReply) => {
    if (isAdmin(request)) return true;
    void reply.code(403).send({ error: "forbidden" });
    return false;
  };

  app.get("/", async (request, reply) => {
    const { userId, walletAddress } = request.user!;
    const admin = isAdmin(request);
    const [wallet, bot, positions, withdrawals, filters] = await Promise.all([
      prisma.tradingWallet.findUnique({
        where: { userId },
        select: { publicKey: true, createdAt: true, keyProvider: true },
      }),
      prisma.tradingBot.findUnique({ where: { userId } }),
      prisma.tradingPosition.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        take: MAX_POSITIONS_SHOWN,
        include: { orders: { orderBy: { createdAt: "asc" } } },
      }),
      prisma.tradingWithdrawal.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: 20 }),
      prisma.userFilter.findMany({ where: { userId }, select: { id: true, name: true, isActive: true } }),
    ]);
    if (!admin && !wallet) return reply.code(403).send({ error: "forbidden" });
    const balance = wallet ? await rpc.getBalance(wallet.publicKey) : null;
    const config = readTradingBotConfig(bot?.config);
    return {
      canTrade: admin,
      keyProviderReady: keys.provider !== null,
      keyProviderProblem: keys.provider ? null : keys.reason,
      withdrawTo: walletAddress,
      wallet: wallet
        ? { publicKey: wallet.publicKey, createdAt: wallet.createdAt, balanceLamports: lamportsJson(balance) }
        : null,
      bot: {
        enabled: bot?.enabled ?? false,
        config,
        lastRunAt: bot?.lastRunAt ?? null,
        lastError: bot?.lastError ?? null,
        exitPlanSummary: describeExitPlan(effectiveExitPlan(config)),
      },
      defaults: {
        exitPlan: EXIT_PLAN,
        exitPlanSummary: describeExitPlan(EXIT_PLAN),
        maxBuySol: env.TRADING_MAX_BUY_SOL,
      },
      sources: { filters, models },
      positions: positions.map((p) => ({
        id: p.id,
        mint: p.mint,
        symbol: p.symbol,
        source: p.sourceLabel,
        sourceKind: p.sourceKind,
        signalAt: p.signalAt,
        status: p.status,
        entryLamports: lamportsJson(p.entryLamports),
        swapInLamports: lamportsJson(p.swapInLamports),
        proceedsLamports: lamportsJson(p.proceedsLamports),
        tokensBought: p.tokensBought,
        tokensHeld: p.tokensHeld,
        decimals: p.decimals,
        rungsTaken: p.rungsTaken,
        lastMultiple: p.lastMultiple,
        highMultiple: p.highMultiple,
        lastPricedAt: p.lastPricedAt,
        openedAt: p.openedAt,
        closedAt: p.closedAt,
        closeReason: p.closeReason,
        closeRequested: p.closeRequested,
        error: p.error,
        exitPlanSummary: describeExitPlan(readExitPlan(p.exitPlan)),
        orders: p.orders.map((o) => ({
          side: o.side,
          reason: o.reason,
          status: o.status,
          signature: o.signature,
          lamportsDelta: lamportsJson(o.lamportsDelta),
          createdAt: o.createdAt,
          error: o.error,
        })),
      })),
      withdrawals: withdrawals.map((w) => ({
        id: w.id,
        destination: w.destination,
        requestedLamports: lamportsJson(w.requestedLamports),
        sentLamports: lamportsJson(w.sentLamports),
        status: w.status,
        signature: w.signature,
        error: w.error,
        createdAt: w.createdAt,
        settledAt: w.settledAt,
      })),
    };
  });

  /** Creates the signed-in admin's trading wallet (idempotent). */
  app.post("/wallet", async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    if (!keys.provider)
      return reply.code(503).send({ error: `wallet custody is not configured: ${keys.reason}` });
    try {
      const wallet = await ensureTradingWallet(request.user!.userId, keys.provider);
      return { publicKey: wallet.publicKey };
    } catch (err) {
      request.log.error({ err: String(err) }, "trading wallet creation failed");
      return reply.code(502).send({ error: "could not create the wallet (key service unavailable)" });
    }
  });

  /** Switches the bot on or off and/or replaces its settings. */
  app.put("/bot", async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const parsed = botPatchSchema.safeParse(request.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return reply
        .code(400)
        .send({ error: issue ? `${issue.path.join(".")}: ${issue.message}` : "invalid request" });
    }
    const { userId } = request.user!;
    const wallet = await prisma.tradingWallet.findUnique({ where: { userId }, select: { id: true } });
    if (!wallet) return reply.code(409).send({ error: "create the trading wallet first" });
    const existing = await prisma.tradingBot.findUnique({ where: { userId } });
    let config = parsed.data.config ?? readTradingBotConfig(existing?.config);
    if (parsed.data.config) {
      // Only the user's own filters, and only models that exist on this deployment.
      const owned = new Set(
        (
          await prisma.userFilter.findMany({
            where: { userId, id: { in: config.sources.filterIds } },
            select: { id: true },
          })
        ).map((f) => f.id),
      );
      const known = new Set(models.map((m) => m.id));
      config = {
        ...config,
        sources: {
          ...config.sources,
          filterIds: config.sources.filterIds.filter((id) => owned.has(id)),
          models: config.sources.models.filter((id) => known.has(id)),
        },
      };
    }
    const enabled = parsed.data.enabled ?? existing?.enabled ?? false;
    // Switching on starts the signal window now: the bot never buys a backlog.
    const turningOn = enabled && !(existing?.enabled ?? false);
    const data = {
      enabled,
      config: config as unknown as Prisma.InputJsonValue,
      ...(turningOn ? { signalsFrom: new Date() } : {}),
    };
    const bot = await prisma.tradingBot.upsert({
      where: { userId },
      create: { userId, ...data },
      update: data,
    });
    return { enabled: bot.enabled, config: readTradingBotConfig(bot.config) };
  });

  /** Sells one position in full on the next pass. */
  app.post<{ Params: { id: string } }>("/positions/:id/sell", async (request, reply) => {
    const updated = await prisma.tradingPosition.updateMany({
      where: { id: request.params.id, userId: request.user!.userId, status: "open" },
      data: { closeRequested: true },
    });
    if (updated.count === 0) return reply.code(404).send({ error: "no open position with that id" });
    return { ok: true };
  });

  /** The panic button: stops new entries and sells every open position on the next pass. */
  app.post("/sell-all", async (request) => {
    const { userId } = request.user!;
    await prisma.tradingBot.updateMany({ where: { userId }, data: { enabled: false } });
    const updated = await prisma.tradingPosition.updateMany({
      where: { userId, status: "open" },
      data: { closeRequested: true },
    });
    return { ok: true, positions: updated.count };
  });

  /** Asks the worker to send SOL to the sign-in wallet. One withdrawal in flight at a time. */
  app.post("/withdraw", async (request, reply) => {
    const parsed = withdrawSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'amount must be lamports or "max"' });
    const { userId } = request.user!;
    const [wallet, user] = await Promise.all([
      prisma.tradingWallet.findUnique({ where: { userId }, select: { publicKey: true } }),
      prisma.user.findUnique({ where: { id: userId }, select: { walletAddress: true } }),
    ]);
    if (!wallet || !user) return reply.code(404).send({ error: "no trading wallet" });
    const requested = parsed.data.amount === "max" ? null : BigInt(parsed.data.amount);
    if (requested !== null && requested < RENT_EXEMPT_MIN_LAMPORTS) {
      return reply
        .code(400)
        .send({ error: `withdraw at least ${Number(RENT_EXEMPT_MIN_LAMPORTS) / LAMPORTS_PER_SOL} SOL` });
    }
    // One at a time, under the user's row lock, so two clicks can't both pass the check.
    const created = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
      const inFlight = await tx.tradingWithdrawal.count({
        where: { userId, status: { in: ["requested", "pending"] } },
      });
      if (inFlight > 0) return null;
      return tx.tradingWithdrawal.create({
        data: { userId, destination: user.walletAddress, requestedLamports: requested },
      });
    });
    if (!created) return reply.code(409).send({ error: "a withdrawal is already in progress" });
    request.log.info({ userId, amount: parsed.data.amount }, "trading withdrawal requested");
    return { id: created.id, destination: created.destination, status: created.status };
  });
}
