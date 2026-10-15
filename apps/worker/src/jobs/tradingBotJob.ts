import {
  adminWalletSet,
  createLogger,
  ensureServerWalletAccount,
  loadServerWalletKey,
  createKeyProvider,
  JupiterSwapClient,
  PumpPortalSwapClient,
  runTradingEngine,
  solToLamports,
  TradingRpc,
  type Env,
} from "@trenchscanner/core";
import { JobFailure, type JobRunMeta } from "../scheduler.js";

/**
 * The trading-bot job: one engine pass (packages/core/src/trading/engine.ts) every
 * TRADING_BOT_INTERVAL_SECONDS, in the trader process (WORKER_ROLE=trader). A process without
 * what it needs to trade safely - a key provider it can use, or a real RPC (a bot on the public
 * mainnet RPC is a stop-loss waiting on a 429) - fails every run with the reason, so
 * /health/worker shows a misconfigured bot rather than a silent one. A pass in which a stage
 * failed (settling, exits, ...) is reported as failed too, with its counts kept.
 */
export function createTradingBotRunner(env: Env): () => Promise<JobRunMeta> {
  const keys = createKeyProvider({ ...env, NODE_ENV: process.env.NODE_ENV });
  const admins = adminWalletSet(env);
  const hasRpc = Boolean(env.HELIUS_API_KEY || env.SOLANA_RPC_URL);
  const rpc = new TradingRpc({
    rpcUrl: env.SOLANA_RPC_URL || undefined,
    apiKey: env.HELIUS_API_KEY || undefined,
  });
  const swap = new JupiterSwapClient({
    // The bot's own key only: sharing the scan's would let a price sweep rate-limit a stop-loss.
    apiKey: env.TRADING_JUPITER_API_KEY || undefined,
    baseUrl: env.TRADING_JUPITER_BASE_URL || undefined,
  });
  const fallback = env.TRADING_PUMPPORTAL_FALLBACK ? new PumpPortalSwapClient() : null;
  // The server wallet's key, from this process's environment only (never logged). A key that is
  // set but wrong fails every run with the reason; the custodial wallets keep trading regardless.
  const server = loadServerWalletKey(env);
  if (server.problem) createLogger("trading").error(`server wallet disabled: ${server.problem}`);
  let serverAccountId: string | null = null;
  if (!env.TRADING_JUPITER_API_KEY) {
    // Jupiter has been moving keyless traffic off lite-api.jup.ag; a key (free at portal.jup.ag)
    // puts swaps on api.jup.ag with their own limit.
    createLogger("trading").warn(
      "no Jupiter API key: swaps and prices use the keyless lite host; set TRADING_JUPITER_API_KEY",
    );
  }
  return async () => {
    // Without KMS the custodial wallets can't sign, but the server wallet (its key in the
    // environment) still trades; the run is reported as failed so the gap is visible.
    if (!keys.provider && !server.key) throw new Error(`trading bot has no key provider: ${keys.reason}`);
    if (!hasRpc) throw new Error("trading bot has no RPC: set HELIUS_API_KEY or SOLANA_RPC_URL");
    if (server.key && !serverAccountId) serverAccountId = await ensureServerWalletAccount();
    const { failedStages, ...counts } = await runTradingEngine({
      serverWallet:
        server.key && serverAccountId
          ? {
              userId: serverAccountId,
              publicKey: server.key.publicKey,
              seed: server.key.seed,
              withdrawTo: server.key.withdrawTo,
            }
          : null,
      rpc,
      swap,
      fallback,
      keys: keys.provider,
      maxPriorityFeeLamports: solToLamports(env.TRADING_MAX_PRIORITY_FEE_SOL),
      canTrade: (wallet) => admins.has(wallet),
      maxBuyLamports: solToLamports(env.TRADING_MAX_BUY_SOL),
      maxDailySpendLamports: solToLamports(env.TRADING_MAX_DAILY_SPEND_SOL),
      maxSlippageBps: env.TRADING_MAX_SLIPPAGE_BPS,
    });
    const meta: JobRunMeta = {
      ...counts,
      serverWallet: server.key ? "on" : server.problem ? "misconfigured" : "off",
    };
    if (server.problem) throw new JobFailure(`server wallet disabled: ${server.problem}`, meta);
    if (!keys.provider) throw new JobFailure(`custodial wallets can't sign: ${keys.reason}`, meta);
    if (failedStages.length > 0)
      throw new JobFailure(`trading pass stages failed: ${failedStages.join(", ")}`, meta);
    return meta;
  };
}
