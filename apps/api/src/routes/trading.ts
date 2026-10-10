import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import {
  adminWalletSet,
  createKeyProvider,
  describeExitPlan,
  effectiveExitPlan,
  enabledContestants,
  ensureServerWalletAccount,
  ensureTradingWallet,
  EXIT_PLAN,
  LAMPORTS_PER_SOL,
  looksLikeSolanaAddress,
  prisma,
  readExitPlan,
  readTradingBotConfig,
  RENT_EXEMPT_MIN_LAMPORTS,
  serverWithdrawTo,
  TradingRpc,
  tradingBotConfigSchema,
  type Env,
} from "@trenchscanner/core";

/**
 * The trading bot's tab (admin-only while it is new), in two scopes:
 *
 *   /trading/*         the signed-in user's own custodial wallet (key sealed under KMS);
 *   /trading/server/*  the server wallet (key in the trader's environment), run by the admins
 *                      together - see packages/core/src/trading/serverWallet.ts.
 *
 * Who may do what:
 *   - own wallet: creating it and changing its bot are for admins; seeing it, selling and
 *     withdrawing are for anyone who HAS one, so an admin who is later removed can still get
 *     their money out. Withdrawals go only to the sign-in wallet, sealed into the key.
 *   - server wallet: admins only, for everything. Withdrawals go only to
 *     TRADING_SERVER_WALLET_WITHDRAW_TO, read from the environment (and checked again by the
 *     trader against its own), so neither a request nor the database can redirect them.
 *
 * The api never holds a key that can spend: it records requests, and the trader - the one
 * process with kms:Decrypt and the server wallet's secret - carries them out. Changing a bot and
 * withdrawing refuse sessions from a paired phone (QR device link): those tokens live a year on a
 * device. The server's ceilings (TRADING_MAX_*) bound whatever the settings say.
 *
 * With TRADING_BOT_ENABLED off nothing here is registered and every route answers 404.
 */

const MAX_POSITIONS_SHOWN = 100;

const withdrawSchema = z.object({
  /** Lamports as a decimal string, or "max" for everything less the fee. */
  amount: z.union([z.literal("max"), z.string().regex(/^\d{1,18}$/)]),
});

const botPatchSchema = z.object({
  enabled: z.boolean().optional(),
  config: tradingBotConfigSchema.optional(),
});

function lamportsJson(v: bigint | null | undefined): string | null {
  return v === null || v === undefined ? null : v.toString();
}

type Scope = "own" | "server";

/** Whose wallet a request is about, and what it holds. */
interface Owner {
  scope: Scope;
  /** The account the bot, positions and withdrawals belong to. */
  userId: string;
  wallet: { publicKey: string; createdAt: Date | null } | null;
  /** Where withdrawals go; null when they can't (no wallet, or the server's is not configured). */
  withdrawTo: string | null;
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
  const serverAddress = looksLikeSolanaAddress(env.TRADING_SERVER_WALLET_ADDRESS)
    ? env.TRADING_SERVER_WALLET_ADDRESS
    : null;
  let serverAccountId: string | null = null;
  const serverAccount = async () => (serverAccountId ??= await ensureServerWalletAccount());

  app.addHook("preHandler", app.authenticate);

  const isAdmin = (request: FastifyRequest) => admins.has(request.user!.walletAddress);
  const deny = (reply: FastifyReply, error: string) => void reply.code(403).send({ error });
  /** Admins only; with `fromWallet`, also not from a paired phone (the money-moving routes). */
  const requireAdmin = (request: FastifyRequest, reply: FastifyReply, fromWallet = true) => {
    if (!isAdmin(request)) return (deny(reply, "forbidden"), false);
    if (fromWallet && request.user!.deviceId) {
      return (deny(reply, "sign in with your wallet on this device to change the trading bot"), false);
    }
    return true;
  };

  async function ownerFor(scope: Scope, request: FastifyRequest): Promise<Owner> {
    if (scope === "server") {
      return {
        scope,
        userId: await serverAccount(),
        wallet: serverAddress ? { publicKey: serverAddress, createdAt: null } : null,
        withdrawTo: serverAddress ? serverWithdrawTo(env) : null,
      };
    }
    const { userId } = request.user!;
    const wallet = await prisma.tradingWallet.findUnique({
      where: { userId },
      select: { publicKey: true, createdAt: true, withdrawTo: true },
    });
    return { scope, userId, wallet, withdrawTo: wallet?.withdrawTo ?? null };
  }

  /** The filters a bot may follow: the user's own, or for the server bot every admin's. */
  async function followableFilters(owner: Owner, request: FastifyRequest) {
    const rows = await prisma.userFilter.findMany({
      where:
        owner.scope === "server"
          ? { user: { walletAddress: { in: [...admins] } } }
          : { userId: request.user!.userId },
      select: {
        id: true,
        name: true,
        isActive: true,
        armedAt: true,
        user: { select: { walletAddress: true } },
      },
      orderBy: { createdAt: "asc" },
    });
    return rows;
  }

  const state = (scope: Scope) => async (request: FastifyRequest, reply: FastifyReply) => {
    const admin = isAdmin(request);
    if (scope === "server" && !admin) return reply.code(403).send({ error: "forbidden" });
    const owner = await ownerFor(scope, request);
    if (scope === "own" && !admin && !owner.wallet) return reply.code(403).send({ error: "forbidden" });
    const { userId } = owner;
    const [bot, positions, withdrawals, filters] = await Promise.all([
      prisma.tradingBot.findUnique({ where: { userId } }),
      prisma.tradingPosition.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        take: MAX_POSITIONS_SHOWN,
        include: { orders: { orderBy: { createdAt: "asc" } } },
      }),
      prisma.tradingWithdrawal.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: 20 }),
      followableFilters(owner, request),
    ]);
    const balance = owner.wallet ? await rpc.getBalance(owner.wallet.publicKey) : null;
    const config = readTradingBotConfig(bot?.config);
    const custodyReady = scope === "server" ? serverAddress !== null : keys.provider !== null;
    const custodyProblem =
      scope === "server"
        ? serverAddress
          ? null
          : "set TRADING_SERVER_WALLET_ADDRESS (api + trader) and TRADING_SERVER_WALLET_SECRET_KEY (trader only)"
        : keys.provider
          ? null
          : keys.reason;
    return {
      scope,
      canTrade: admin,
      /** Admins see the server wallet's tab when it is configured. */
      serverWallet: admin ? { configured: serverAddress !== null } : null,
      keyProviderReady: custodyReady,
      keyProviderProblem: custodyProblem,
      withdrawTo: owner.withdrawTo,
      wallet: owner.wallet
        ? {
            publicKey: owner.wallet.publicKey,
            createdAt: owner.wallet.createdAt,
            withdrawTo: owner.withdrawTo,
            balanceLamports: lamportsJson(balance),
          }
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
        maxDailySpendSol: env.TRADING_MAX_DAILY_SPEND_SOL,
        maxSlippageBps: env.TRADING_MAX_SLIPPAGE_BPS,
        maxPriorityFeeSol: env.TRADING_MAX_PRIORITY_FEE_SOL,
      },
      // A followed filter edited since the settings were saved is paused until they are saved again.
      sources: {
        filters: filters.map((f) => ({
          id: f.id,
          name: scope === "server" ? `${f.name} (${f.user.walletAddress.slice(0, 4)}…)` : f.name,
          isActive: f.isActive,
          changedSinceSaved: bot ? f.armedAt > bot.configSavedAt : false,
        })),
        models,
      },
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
  };

  const saveBot = (scope: Scope) => async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireAdmin(request, reply)) return;
    const parsed = botPatchSchema.safeParse(request.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return reply
        .code(400)
        .send({ error: issue ? `${issue.path.join(".")}: ${issue.message}` : "invalid request" });
    }
    const owner = await ownerFor(scope, request);
    if (!owner.wallet) {
      return reply.code(409).send({
        error: scope === "server" ? "the server wallet is not configured" : "create the trading wallet first",
      });
    }
    const { userId } = owner;
    const limits = parsed.data.config;
    if (limits) {
      if (limits.buySol > env.TRADING_MAX_BUY_SOL)
        return reply
          .code(400)
          .send({ error: `buySol: at most ${env.TRADING_MAX_BUY_SOL} SOL on this server` });
      if (limits.maxDailySpendSol > env.TRADING_MAX_DAILY_SPEND_SOL)
        return reply
          .code(400)
          .send({ error: `maxDailySpendSol: at most ${env.TRADING_MAX_DAILY_SPEND_SOL} SOL on this server` });
      if (limits.maxPriorityFeeSol > env.TRADING_MAX_PRIORITY_FEE_SOL)
        return reply.code(400).send({
          error: `maxPriorityFeeSol: at most ${env.TRADING_MAX_PRIORITY_FEE_SOL} SOL on this server`,
        });
      if (limits.slippageBps > env.TRADING_MAX_SLIPPAGE_BPS)
        return reply
          .code(400)
          .send({ error: `slippageBps: at most ${env.TRADING_MAX_SLIPPAGE_BPS} on this server` });
    }
    const existing = await prisma.tradingBot.findUnique({ where: { userId } });
    let config = parsed.data.config ?? readTradingBotConfig(existing?.config);
    if (parsed.data.config) {
      // Only filters this bot may follow, and only models that exist on this deployment.
      const allowed = new Set((await followableFilters(owner, request)).map((f) => f.id));
      const known = new Set(models.map((m) => m.id));
      config = {
        ...config,
        sources: {
          ...config.sources,
          filterIds: config.sources.filterIds.filter((id) => allowed.has(id)),
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
      // Saving the settings confirms the followed filters as they are now (see loadSignals).
      ...(parsed.data.config ? { configSavedAt: new Date() } : {}),
    };
    const bot = await prisma.tradingBot.upsert({
      where: { userId },
      create: { userId, ...data },
      update: data,
    });
    request.log.info(
      { scope, by: request.user!.walletAddress, enabled: bot.enabled },
      "trading bot settings saved",
    );
    return { enabled: bot.enabled, config: readTradingBotConfig(bot.config) };
  };

  const sellOne =
    (scope: Scope) => async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      if (scope === "server" && !requireAdmin(request, reply, false)) return;
      const owner = await ownerFor(scope, request);
      const updated = await prisma.tradingPosition.updateMany({
        where: { id: request.params.id, userId: owner.userId, status: { in: ["open", "stuck"] } },
        data: { closeRequested: true },
      });
      if (updated.count === 0) return reply.code(404).send({ error: "no open position with that id" });
      return { ok: true };
    };

  /** The panic button: stops new entries and sells every open position on the next pass. */
  const sellAll = (scope: Scope) => async (request: FastifyRequest, reply: FastifyReply) => {
    if (scope === "server" && !requireAdmin(request, reply, false)) return;
    const { userId } = await ownerFor(scope, request);
    await prisma.tradingBot.updateMany({ where: { userId }, data: { enabled: false } });
    const updated = await prisma.tradingPosition.updateMany({
      where: { userId, status: { in: ["open", "stuck"] } },
      data: { closeRequested: true },
    });
    return { ok: true, positions: updated.count };
  };

  /** Asks the trader to send SOL to the wallet's withdrawal address. One in flight at a time. */
  const withdraw = (scope: Scope) => async (request: FastifyRequest, reply: FastifyReply) => {
    if (scope === "server" && !requireAdmin(request, reply)) return;
    const parsed = withdrawSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'amount must be lamports or "max"' });
    const owner = await ownerFor(scope, request);
    if (!owner.wallet) return reply.code(404).send({ error: "no trading wallet" });
    if (!owner.withdrawTo) {
      return reply.code(409).send({
        error:
          scope === "server"
            ? "server wallet withdrawals are off: set TRADING_SERVER_WALLET_WITHDRAW_TO on the api and the trader"
            : "this wallet has no withdrawal address",
      });
    }
    if (scope === "own") {
      const user = await prisma.user.findUnique({
        where: { id: owner.userId },
        select: { walletAddress: true },
      });
      if (owner.withdrawTo !== user?.walletAddress) {
        return reply.code(409).send({ error: "this wallet's withdrawal address is not your sign-in wallet" });
      }
    }
    const requested = parsed.data.amount === "max" ? null : BigInt(parsed.data.amount);
    if (requested !== null && requested < RENT_EXEMPT_MIN_LAMPORTS) {
      return reply
        .code(400)
        .send({ error: `withdraw at least ${Number(RENT_EXEMPT_MIN_LAMPORTS) / LAMPORTS_PER_SOL} SOL` });
    }
    const { userId } = owner;
    const destination = owner.withdrawTo;
    // One at a time, under the account's row lock, so two clicks can't both pass the check.
    const created = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
      const inFlight = await tx.tradingWithdrawal.count({
        where: { userId, status: { in: ["requested", "sending", "pending"] } },
      });
      if (inFlight > 0) return null;
      return tx.tradingWithdrawal.create({ data: { userId, destination, requestedLamports: requested } });
    });
    if (!created) return reply.code(409).send({ error: "a withdrawal is already in progress" });
    request.log.info(
      { scope, by: request.user!.walletAddress, amount: parsed.data.amount },
      "trading withdrawal requested",
    );
    return { id: created.id, destination: created.destination, status: created.status };
  };

  // ── The user's own custodial wallet ──
  app.get("/", state("own"));
  /** Creates the signed-in admin's trading wallet (idempotent). */
  app.post("/wallet", async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    if (!keys.provider)
      return reply.code(503).send({ error: `wallet custody is not configured: ${keys.reason}` });
    try {
      // Withdrawals will only ever go to the account's sign-in wallet, sealed into the key here.
      const user = await prisma.user.findUnique({
        where: { id: request.user!.userId },
        select: { walletAddress: true },
      });
      if (!user) return reply.code(401).send({ error: "unauthenticated" });
      const wallet = await ensureTradingWallet(request.user!.userId, user.walletAddress, keys.provider);
      return { publicKey: wallet.publicKey };
    } catch (err) {
      request.log.error({ err: String(err) }, "trading wallet creation failed");
      return reply.code(502).send({ error: "could not create the wallet (key service unavailable)" });
    }
  });
  app.put("/bot", saveBot("own"));
  app.post<{ Params: { id: string } }>("/positions/:id/sell", sellOne("own"));
  app.post("/sell-all", sellAll("own"));
  app.post("/withdraw", withdraw("own"));

  // ── The server wallet (admins only) ──
  app.get("/server", state("server"));
  app.put("/server/bot", saveBot("server"));
  app.post<{ Params: { id: string } }>("/server/positions/:id/sell", sellOne("server"));
  app.post("/server/sell-all", sellAll("server"));
  app.post("/server/withdraw", withdraw("server"));
}
