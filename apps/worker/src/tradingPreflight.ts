import "./bootstrap-env.js"; // must run before any @trenchscanner/core import - see file comment
import {
  createKeyProvider,
  guardSwapTransaction,
  JupiterSwapClient,
  loadEnv,
  loadServerWalletKey,
  prisma,
  solToLamports,
  TradingRpc,
  withWalletKey,
  WSOL_MINT,
  type TradeExpectation,
} from "@trenchscanner/core";

/**
 * The trading bot's preflight: run it on the trader service (Render -> trenchscanner-trader ->
 * Shell: `npm run trading:preflight -w @trenchscanner/worker`) before switching the bot on, and
 * after any change to its settings or code. Read-only: it signs nothing and sends nothing.
 *
 * Unit tests run against fakes and share the code's own constants, so they cannot catch a wrong
 * program id or an API that changed shape - the bot would then refuse (or fail) every real trade.
 * This builds REAL swap transactions with Jupiter for a real funded wallet and puts them through
 * the production guard (allowlist + simulation against mainnet), and checks every dependency the
 * bot needs with the credentials this service actually has.
 *
 * Exit code 0 when everything passed; 1 when anything failed.
 */

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
/** A long-lived, well-funded system wallet used only as the subject of simulations (never signs). */
const DEFAULT_PROBE_WALLET = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

let failures = 0;
const ok = (what: string, detail = "") => console.log(`  OK    ${what}${detail ? ` - ${detail}` : ""}`);
const warn = (what: string, detail: string) => console.log(`  WARN  ${what} - ${detail}`);
const fail = (what: string, detail: string) => {
  failures++;
  console.log(`  FAIL  ${what} - ${detail}`);
};
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 300);

async function main() {
  const env = loadEnv();
  console.log("Trading bot preflight (read-only)\n");

  console.log("Configuration");
  if (env.TRADING_BOT_ENABLED) ok("TRADING_BOT_ENABLED");
  else warn("TRADING_BOT_ENABLED", "off: the bot will not run until it is true");
  if (env.WORKER_ROLE === "trader" || env.WORKER_ROLE === "all") ok("WORKER_ROLE", env.WORKER_ROLE);
  else fail("WORKER_ROLE", `${env.WORKER_ROLE}: run this on the trader service`);
  if (env.TRADING_JUPITER_API_KEY || env.JUPITER_API_KEY) ok("Jupiter API key");
  else warn("Jupiter API key", "none: using the keyless lite host; set TRADING_JUPITER_API_KEY");
  if (env.TRADING_PUMPPORTAL_FALLBACK)
    warn(
      "TRADING_PUMPPORTAL_FALLBACK",
      "on: PumpPortal routes bonding-curve trades through its own program, which the guard refuses",
    );

  console.log("\nChain (RPC)");
  const rpc = new TradingRpc({
    rpcUrl: env.SOLANA_RPC_URL || undefined,
    apiKey: env.HELIUS_API_KEY || undefined,
  });
  if (!env.HELIUS_API_KEY && !env.SOLANA_RPC_URL) fail("RPC", "set HELIUS_API_KEY or SOLANA_RPC_URL");
  const height = await rpc.getBlockHeight();
  if (height) ok("block height", String(height));
  else fail("RPC", "no answer to getBlockHeight");

  console.log("\nKeys");
  const keys = createKeyProvider({ ...env, NODE_ENV: process.env.NODE_ENV });
  if (!keys.provider) fail("key provider", keys.reason);
  else {
    ok("key provider", keys.provider.name);
    // Opening a real wallet proves kms:Decrypt works and the sealed data is intact.
    try {
      const wallet = await prisma.tradingWallet.findFirst({ orderBy: { createdAt: "asc" } });
      if (!wallet) warn("custodial wallets", "none yet: nothing to test-open");
      else {
        await withWalletKey(wallet, keys.provider, () => undefined);
        ok("custodial wallet opens", `${wallet.publicKey.slice(0, 6)}… (key checked against its address)`);
      }
    } catch (err) {
      fail("custodial wallet opens", errText(err));
    }
  }
  const server = loadServerWalletKey(env);
  if (server.key) {
    ok("server wallet key", `matches ${server.key.publicKey.slice(0, 6)}…`);
    if (server.key.withdrawTo) ok("server wallet withdrawals", `to ${server.key.withdrawTo.slice(0, 6)}…`);
    else warn("server wallet withdrawals", "off (TRADING_SERVER_WALLET_WITHDRAW_TO empty)");
    server.key.seed.fill(0);
  } else if (server.problem) fail("server wallet key", server.problem);
  else ok("server wallet", "not configured");

  console.log("\nJupiter");
  const swap = new JupiterSwapClient({
    apiKey: env.TRADING_JUPITER_API_KEY || env.JUPITER_API_KEY || undefined,
    baseUrl: env.TRADING_JUPITER_BASE_URL || undefined,
  });
  try {
    const prices = await swap.pricesUsd([WSOL_MINT]);
    const sol = prices.get(WSOL_MINT);
    if (sol) ok("Price API", `SOL $${sol.toFixed(2)}`);
    else fail("Price API", "no SOL price");
  } catch (err) {
    fail("Price API", errText(err));
  }

  // Real routes through the production guard. The probe wallet is only simulated against.
  const probe = process.env.PREFLIGHT_PROBE_WALLET || DEFAULT_PROBE_WALLET;
  console.log(`\nGuard on real routes (simulated for ${probe.slice(0, 6)}…)`);
  const prio = solToLamports(0.002);
  const external = (n: bigint) => n / 50n + 1_000_000n;
  const cases: { label: string; input: string; output: string; amount: bigint; side: "buy" | "sell" }[] = [
    { label: "buy SOL->USDC", input: WSOL_MINT, output: USDC, amount: solToLamports(0.01), side: "buy" },
    { label: "sell USDC->SOL", input: USDC, output: WSOL_MINT, amount: 500_000n, side: "sell" },
  ];
  const pumpMint = process.env.PREFLIGHT_PUMP_MINT;
  if (pumpMint) {
    cases.push({
      label: `buy SOL->${pumpMint.slice(0, 6)}…`,
      input: WSOL_MINT,
      output: pumpMint,
      amount: solToLamports(0.01),
      side: "buy",
    });
  }
  for (const c of cases) {
    try {
      const quote = await swap.quote({
        inputMint: c.input,
        outputMint: c.output,
        amount: c.amount,
        slippageBps: 1500,
      });
      const built = await swap.swapTransaction({
        quote,
        userPublicKey: probe,
        maxPriorityFeeLamports: Number(prio),
      });
      const out = BigInt(quote.outAmount);
      const expect: TradeExpectation =
        c.side === "buy"
          ? {
              kind: "buy",
              mint: c.output,
              minOut: BigInt(quote.otherAmountThreshold),
              maxSolDrop: c.amount + prio + 5_000_000n + external(c.amount),
              maxExternalLamports: external(c.amount),
              maxPriorityFeeLamports: prio,
            }
          : {
              kind: "sell",
              mint: c.input,
              amount: c.amount,
              minSolOut: BigInt(quote.otherAmountThreshold),
              feeAllowance: prio + 100_000n + external(out),
              maxExternalLamports: external(out),
              maxPriorityFeeLamports: prio,
            };
      await guardSwapTransaction(rpc, built.transaction, probe, expect);
      ok(c.label, "built by Jupiter, passed the allowlist and the simulation");
    } catch (err) {
      fail(c.label, errText(err));
    }
  }

  console.log(failures === 0 ? "\nPreflight passed." : `\nPreflight FAILED: ${failures} check(s).`);
  await prisma.$disconnect().catch(() => undefined);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("preflight crashed:", errText(err));
  await prisma.$disconnect().catch(() => undefined);
  process.exit(1);
});
