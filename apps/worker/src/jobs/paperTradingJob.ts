import {
  adminWalletSet,
  JupiterSwapClient,
  runPaperTrading,
  TradingRpc,
  type Env,
} from "@trenchscanner/core";
import type { JobRunMeta } from "../scheduler.js";

/**
 * Paper trading (packages/core/src/trading/paper.ts): admins' strategies run on live signals and
 * live Jupiter quotes with simulated SOL. It reads (quotes, prices, mint accounts) and never signs
 * or sends, so it runs on the scanner whether or not the real bot is on, and does nothing until an
 * admin starts a strategy.
 */
export function createPaperTradingRunner(env: Env): () => Promise<JobRunMeta> {
  const admins = adminWalletSet(env);
  const rpc = new TradingRpc({
    rpcUrl: env.SOLANA_RPC_URL || undefined,
    apiKey: env.HELIUS_API_KEY || undefined,
    backupUrl: env.TRADING_BACKUP_RPC_URL || undefined,
  });
  const swap = new JupiterSwapClient({
    apiKey: env.TRADING_JUPITER_API_KEY || undefined,
    baseUrl: env.TRADING_JUPITER_BASE_URL || undefined,
  });
  return async () => {
    const summary = await runPaperTrading({ swap, rpc, canTrade: (wallet) => admins.has(wallet) });
    return { ...summary };
  };
}
