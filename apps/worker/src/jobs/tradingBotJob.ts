import {
  adminWalletSet,
  createKeyProvider,
  JupiterSwapClient,
  runTradingEngine,
  solToLamports,
  TradingRpc,
  type Env,
} from "@trenchscanner/core";
import type { JobRunMeta } from "../scheduler.js";

/**
 * The trading-bot job: one engine pass (packages/core/src/trading/engine.ts) every
 * TRADING_BOT_INTERVAL_SECONDS. Only scheduled with TRADING_BOT_ENABLED. A worker without a key
 * provider it can use (KMS settings missing, or the local provider in production) fails every run
 * with the reason, so /health/worker shows a misconfigured bot rather than a silent one - open
 * positions are not being watched while it does.
 */
export function createTradingBotRunner(env: Env): () => Promise<JobRunMeta> {
  const keys = createKeyProvider({ ...env, NODE_ENV: process.env.NODE_ENV });
  const admins = adminWalletSet(env);
  const rpc = new TradingRpc({
    rpcUrl: env.SOLANA_RPC_URL || undefined,
    apiKey: env.HELIUS_API_KEY || undefined,
  });
  const swap = new JupiterSwapClient({
    apiKey: env.TRADING_JUPITER_API_KEY || env.JUPITER_API_KEY || undefined,
    baseUrl: env.TRADING_JUPITER_BASE_URL || undefined,
  });
  return async () => {
    if (!keys.provider) throw new Error(`trading bot has no key provider: ${keys.reason}`);
    const summary = await runTradingEngine({
      rpc,
      swap,
      keys: keys.provider,
      canTrade: (wallet) => admins.has(wallet),
      maxBuyLamports: solToLamports(env.TRADING_MAX_BUY_SOL),
    });
    return { ...summary };
  };
}
