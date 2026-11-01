import {
  adminWalletSet,
  JupiterSwapClient,
  runPaperTrading,
  sendTradeNotes,
  TelegramApi,
  TradingRpc,
  type Env,
} from "@trenchscanner/core";
import type { FdsaMarketSource } from "../fdsa/review.js";
import type { JobRunMeta } from "../scheduler.js";
import { createFdsaDeskRunner } from "./fdsaDeskJob.js";

/**
 * Paper trading (packages/core/src/trading/paper.ts): admins' strategies run on live signals and
 * live Jupiter quotes with simulated SOL. It reads (quotes, prices, mint accounts) and never signs
 * or sends, so it runs on the scanner whether or not the real bot is on, and does nothing until an
 * admin starts a strategy. The FDSA paper desk runs after the strategies in the same job
 * (fdsaDeskJob.ts), on the same clients.
 */
export function createPaperTradingRunner(
  env: Env,
  shared: {
    /** Seconds-old quotes for FDSA's revise briefs (the scan's Jupiter client; see fdsa/review.ts). */
    market?: FdsaMarketSource | null;
  } = {},
): () => Promise<JobRunMeta> {
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
  // Each strategy's buys, sales and automatic stops, to its owner's private Telegram chats.
  const telegram = env.TELEGRAM_BOT_TOKEN ? new TelegramApi(env.TELEGRAM_BOT_TOKEN) : null;
  const notify = telegram
    ? async (notes: Parameters<typeof sendTradeNotes>[0]) =>
        void (await sendTradeNotes(notes, { telegram, admins }))
    : undefined;
  const runFdsa = createFdsaDeskRunner(env, { swap, rpc, telegram, admins, market: shared.market });
  return async () => {
    // Each pass's failure is its own. A strategies pass that throws (a pool timeout, a rate limit)
    // must not skip the FDSA pass behind it: FDSA's open positions hold their -50% stop only while
    // its pass runs (owner decision 2026-10-31, decision 8; FDSA wiring check 2026-11-01). The
    // strategies' error is rethrown after FDSA has run, so the job still records the failure.
    let strategies: Awaited<ReturnType<typeof runPaperTrading>> | null = null;
    let strategiesError: unknown = null;
    try {
      strategies = await runPaperTrading({ swap, rpc, canTrade: (wallet) => admins.has(wallet), notify });
    } catch (err) {
      strategiesError = err;
    }
    const fdsa = await runFdsa().catch((err: unknown) => ({
      fdsaErrors: 1,
      fdsaError: String(err instanceof Error ? err.message : err).slice(0, 200),
    }));
    if (strategiesError !== null) throw strategiesError;
    return { ...strategies, ...fdsa };
  };
}
