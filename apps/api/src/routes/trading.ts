import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { issueTradeConfirmation, requireTradeConfirmation } from "../tradeConfirm.js";
import {
  adminWalletSet,
  applyTradeAlertsPatch,
  createKeyProvider,
  DEFAULT_TRADING_BOT_CONFIG,
  describeExitPlan,
  effectiveExitPlan,
  enabledContestants,
  ensureServerWalletAccount,
  ensureTradingWallet,
  EXIT_PLAN,
  LAMPORTS_PER_SOL,
  looksLikeSolanaAddress,
  parseTradeAlerts,
  prisma,
  readExitPlan,
  readTradingBotConfig,
  RENT_EXEMPT_MIN_LAMPORTS,
  serverWithdrawTo,
  TradingRpc,
  tradingBotConfigSchema,
  tradingBacktest,
  tradeAlertsPatchSchema,
  type BacktestRow,
  type Env,
} from "@trenchscanner/core";
import { registerPaperTradingRoutes } from "./paperTrading.js";

/**
 * The trading bot's section of the Admin tab, in two scopes:
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
 * device. The server's optional ceilings (TRADING_MAX_*), where set, bound whatever the settings say.
 *
 * With TRADING_BOT_ENABLED off only GET /trading/status, /trading/backtest and the paper-trading
 * routes (/trading/paper, simulated: see paperTrading.ts) are registered; every other route answers
 * 404, so no wallet can be created, no bot changed and nothing sold or withdrawn.
 */

const MAX_POSITIONS_SHOWN = 100;
const BACKTEST_CACHE_MS = 5 * 60_000;

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

/**
 * Whether the bot runs on this deployment and what it is missing, for the status card in
 * Admin -> Trading bot.
 * Names settings, never their values: nothing here is secret.
 */
export function tradingStatus(env: Env, keyProblem: string | null) {
  const serverAddress = looksLikeSolanaAddress(env.TRADING_SERVER_WALLET_ADDRESS);
  const serverWithdrawals = looksLikeSolanaAddress(env.TRADING_SERVER_WALLET_WITHDRAW_TO);
  return {
    enabled: env.TRADING_BOT_ENABLED,
    checks: [
      {
        id: "custody",
        label: "Wallet custody (KMS)",
        ok: keyProblem === null,
        detail: keyProblem ?? `${env.TRADING_KEY_PROVIDER} key provider configured`,
      },
      {
        id: "rpc",
        label: "Paid Solana RPC",
        ok: Boolean(env.HELIUS_API_KEY || env.SOLANA_RPC_URL),
        detail:
          env.HELIUS_API_KEY || env.SOLANA_RPC_URL
            ? "HELIUS_API_KEY or SOLANA_RPC_URL set"
            : "set HELIUS_API_KEY or SOLANA_RPC_URL: a stop-loss on the public RPC waits on rate limits",
      },
      {
        id: "jupiter",
        label: "Jupiter key for swaps",
        ok: Boolean(env.TRADING_JUPITER_API_KEY),
        detail: env.TRADING_JUPITER_API_KEY
          ? "TRADING_JUPITER_API_KEY set"
          : "TRADING_JUPITER_API_KEY not set on the api (recommended on the trader)",
      },
      {
        id: "server-wallet",
        label: "Server wallet (optional)",
        ok: serverAddress && serverWithdrawals,
        detail: !serverAddress
          ? "TRADING_SERVER_WALLET_ADDRESS not set"
          : serverWithdrawals
            ? "address and withdrawal destination set"
            : "TRADING_SERVER_WALLET_WITHDRAW_TO not set: withdrawals are off",
      },
    ],
    // Null where the server sets no ceiling (the default): the bot's own settings decide.
    limits: {
      maxBuySol: env.TRADING_MAX_BUY_SOL ?? null,
      maxDailySpendSol: env.TRADING_MAX_DAILY_SPEND_SOL ?? null,
      maxSlippageBps: env.TRADING_MAX_SLIPPAGE_BPS ?? null,
      maxExitSlippageBps: env.TRADING_MAX_EXIT_SLIPPAGE_BPS,
      maxPriorityFeeSol: env.TRADING_MAX_PRIORITY_FEE_SOL ?? null,
    },
    defaults: DEFAULT_TRADING_BOT_CONFIG,
    exitPlanSummary: describeExitPlan(EXIT_PLAN),
    models: enabledContestants(env.CURATOR_CONTESTANTS).map((c) => ({ id: c.id, name: c.name })),
    pumpPortalFallback: env.TRADING_PUMPPORTAL_FALLBACK,
  };
}

export async function registerTradingRoutes(app: FastifyInstance, { env }: { env: Env }) {
  const admins = adminWalletSet(env);
  const keys = createKeyProvider({ ...env, NODE_ENV: process.env.NODE_ENV });
  const status = tradingStatus(env, keys.provider ? null : keys.reason);

  app.addHook("preHandler", app.authenticate);
  // Read-only, and the one route that exists while the bot is off.
  app.get("/status", async (request, reply) => {
    if (!admins.has(request.user!.walletAddress)) return reply.code(403).send({ error: "forbidden" });
    return status;
  });
  // What the models would have bought lately, with and without the AI gate: read-only, so it is
  // there while the bot is off too. Cached a few minutes; the outcomes behind it settle slowly.
  const backtests = new Map<number, { at: number; rows: Promise<BacktestRow[]> }>();
  app.get<{ Querystring: { days?: string } }>("/backtest", async (request, reply) => {
    if (!admins.has(request.user!.walletAddress)) return reply.code(403).send({ error: "forbidden" });
    const days = Math.min(30, Math.max(1, Math.round(Number(request.query.days ?? 7)) || 7));
    let hit = backtests.get(days);
    if (!hit || Date.now() - hit.at > BACKTEST_CACHE_MS) {
      hit = { at: Date.now(), rows: tradingBacktest(days) };
      hit.rows.catch(() => backtests.delete(days));
      backtests.set(days, hit);
    }
    return { days, models: await hit.rows };
  });
  // Which trade notes reach the admin's Telegram chats, for the live bot and every paper strategy
  // alike (trading/tradeAlerts.ts). There while the bot is off too: paper strategies still send.
  app.get("/alerts", async (request, reply) => {
    if (!admins.has(request.user!.walletAddress)) return reply.code(403).send({ error: "forbidden" });
    const user = await prisma.user.findUnique({
      where: { id: request.user!.userId },
      select: { tradeAlerts: true },
    });
    if (!user) return reply.code(401).send({ error: "unauthenticated" });
    return { alerts: parseTradeAlerts(user.tradeAlerts) };
  });
  app.put("/alerts", async (request, reply) => {
    if (!admins.has(request.user!.walletAddress)) return reply.code(403).send({ error: "forbidden" });
    // The schema is strict, so the signed confirmation comes off before parsing. Validated before
    // the confirmation is spent, so a bad body doesn't burn the signature.
    const { confirmation: _confirmation, ...patch } = (request.body ?? {}) as Record<string, unknown>;
    const parsed = tradeAlertsPatchSchema.safeParse(patch);
    if (!parsed.success)
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    if (!(await requireTradeConfirmation(request, reply))) return;
    const userId = request.user!.userId;
    // Merged under the row lock, as settings.ts does: each switch saves as it is pressed.
    const next = await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ tradeAlerts: unknown }[]>`
        SELECT "tradeAlerts" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
      if (rows.length === 0) return null;
      const merged = applyTradeAlertsPatch(parseTradeAlerts(rows[0]!.tradeAlerts), parsed.data);
      await tx.user.update({
        where: { id: userId },
        data: { tradeAlerts: merged as unknown as Prisma.InputJsonValue },
      });
      return merged;
    });
    if (!next) return reply.code(401).send({ error: "unauthenticated" });
    return { alerts: next };
  });
  // Paper trading holds no wallet and moves nothing: there whether or not the bot is on.
  await app.register((paper) => registerPaperTradingRoutes(paper, { env, admins }), { prefix: "/paper" });
  if (!env.TRADING_BOT_ENABLED) return;
  const rpc = new TradingRpc({
    rpcUrl: env.SOLANA_RPC_URL || undefined,
    apiKey: env.HELIUS_API_KEY || undefined,
    backupUrl: env.TRADING_BACKUP_RPC_URL || undefined,
    jitoUrl: env.TRADING_JITO_URL || undefined,
  });
  const models = enabledContestants(env.CURATOR_CONTESTANTS).map((c) => ({ id: c.id, name: c.name }));
  const serverAddress = looksLikeSolanaAddress(env.TRADING_SERVER_WALLET_ADDRESS)
    ? env.TRADING_SERVER_WALLET_ADDRESS
    : null;
  let serverAccountId: string | null = null;
  const serverAccount = async () => (serverAccountId ??= await ensureServerWalletAccount());

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
        maxBuySol: env.TRADING_MAX_BUY_SOL ?? null,
        maxDailySpendSol: env.TRADING_MAX_DAILY_SPEND_SOL ?? null,
        maxSlippageBps: env.TRADING_MAX_SLIPPAGE_BPS ?? null,
        maxExitSlippageBps: env.TRADING_MAX_EXIT_SLIPPAGE_BPS,
        maxPriorityFeeSol: env.TRADING_MAX_PRIORITY_FEE_SOL ?? null,
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
    if (!(await requireTradeConfirmation(request, reply))) return;
    const owner = await ownerFor(scope, request);
    if (!owner.wallet) {
      return reply.code(409).send({
        error: scope === "server" ? "the server wallet is not configured" : "create the trading wallet first",
      });
    }
    const { userId } = owner;
    const limits = parsed.data.config;
    if (limits) {
      // The optional TRADING_MAX_* ceilings, where the server sets them; unset, none applies.
      const over = [
        ["buySol", limits.buySol, env.TRADING_MAX_BUY_SOL, "SOL"],
        ["maxDailySpendSol", limits.maxDailySpendSol, env.TRADING_MAX_DAILY_SPEND_SOL, "SOL"],
        ["maxPriorityFeeSol", limits.maxPriorityFeeSol, env.TRADING_MAX_PRIORITY_FEE_SOL, "SOL"],
        ["slippageBps", limits.slippageBps, env.TRADING_MAX_SLIPPAGE_BPS, "bps"],
        // Exits (against their own ceiling) and the Jito tip too: the trader clamps them, but the
        // settings should say so.
        ["exitSlippageBps", limits.exitSlippageBps, env.TRADING_MAX_EXIT_SLIPPAGE_BPS, "bps"],
        ["exitSlippageMaxBps", limits.exitSlippageMaxBps, env.TRADING_MAX_EXIT_SLIPPAGE_BPS, "bps"],
        ["jitoTipSol", limits.jitoTipSol, env.TRADING_MAX_PRIORITY_FEE_SOL, "SOL"],
      ] as const;
      for (const [field, value, cap, unit] of over) {
        if (cap !== undefined && value > cap)
          return reply.code(400).send({ error: `${field}: at most ${cap} ${unit} on this server` });
      }
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
      // ...and the daily loss limit's count: a bot it paused can be switched back on.
      ...(turningOn ? { signalsFrom: new Date(), lossWindowFrom: new Date() } : {}),
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

  /**
   * A requested sale doesn't wait out a failure backoff (up to hours after many failed sales):
   * the next pass tries it. An exit claim (at most a minute ahead) is left alone, so a sale in
   * flight is not sent twice.
   */
  const sellSoon = (where: Prisma.TradingPositionWhereInput) =>
    prisma.tradingPosition.updateMany({
      where: { ...where, nextAttemptAt: { gt: new Date(Date.now() + 60_000) } },
      data: { nextAttemptAt: new Date() },
    });

  const sellOne =
    (scope: Scope) => async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      if (scope === "server" && !requireAdmin(request, reply, false)) return;
      if (!(await requireTradeConfirmation(request, reply))) return;
      const owner = await ownerFor(scope, request);
      const where = { id: request.params.id, userId: owner.userId, status: { in: ["open", "stuck"] } };
      const updated = await prisma.tradingPosition.updateMany({ where, data: { closeRequested: true } });
      if (updated.count === 0) return reply.code(404).send({ error: "no open position with that id" });
      await sellSoon(where);
      return { ok: true };
    };

  /** The panic button: stops new entries and sells every open position on the next pass. */
  const sellAll = (scope: Scope) => async (request: FastifyRequest, reply: FastifyReply) => {
    if (scope === "server" && !requireAdmin(request, reply, false)) return;
    if (!(await requireTradeConfirmation(request, reply))) return;
    const { userId } = await ownerFor(scope, request);
    await prisma.tradingBot.updateMany({ where: { userId }, data: { enabled: false } });
    const where = { userId, status: { in: ["open", "stuck"] } };
    const updated = await prisma.tradingPosition.updateMany({ where, data: { closeRequested: true } });
    await sellSoon(where);
    return { ok: true, positions: updated.count };
  };

  /** Asks the trader to send SOL to the wallet's withdrawal address. One in flight at a time. */
  const withdraw = (scope: Scope) => async (request: FastifyRequest, reply: FastifyReply) => {
    if (scope === "server" && !requireAdmin(request, reply)) return;
    // The owner's own wallet too, as the header promises: a paired phone's session lives a year on
    // a device, and must not be able to empty the wallet (to the sign-in wallet, but empty it).
    if (scope === "own" && request.user!.deviceId) {
      return deny(reply, "sign in with your wallet on this device to withdraw");
    }
    const parsed = withdrawSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'amount must be lamports or "max"' });
    if (!(await requireTradeConfirmation(request, reply))) return;
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

  /** The text a wallet signs to approve one of the actions below (tradeConfirm.ts). */
  // Any signed-in wallet: a former admin's wallet can still sell out and withdraw. The routes
  // themselves decide who may act; a confirmation only proves the wallet approved the request.
  app.post(
    "/confirm",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => issueTradeConfirmation(request, reply),
  );

  // ── The user's own custodial wallet ──
  app.get("/", state("own"));
  /** Creates the signed-in admin's trading wallet (idempotent). */
  app.post("/wallet", async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    if (!(await requireTradeConfirmation(request, reply))) return;
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
