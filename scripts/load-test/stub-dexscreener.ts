/**
 * A stand-in for DexScreener's batch lookup (/tokens/v1/solana/<mints>) for the API load test:
 * answers every mint with one pair after STUB_LATENCY_MS (DexScreener's usual 150-450 ms), and
 * counts the calls, so the test never sends traffic to DexScreener and shows how many lookups the
 * readers' live ticks would have cost. Start the API with DEXSCREENER_BASE_URL pointing here.
 *
 *   npx tsx scripts/load-test/stub-dexscreener.ts   # listens on STUB_PORT (4012)
 */
import { createServer } from "node:http";

const PORT = Number(process.env.STUB_PORT ?? 4012);
const LATENCY_MS = Number(process.env.STUB_LATENCY_MS ?? 300);
let calls = 0;
let mints = 0;

createServer((req, res) => {
  const m = /^\/tokens\/v1\/solana\/([^?]+)/.exec(req.url ?? "");
  if (req.url === "/stats") {
    res.end(JSON.stringify({ calls, mints }));
    return;
  }
  const list = m ? decodeURIComponent(m[1]!).split(",").filter(Boolean) : [];
  calls += 1;
  mints += list.length;
  setTimeout(() => {
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify(
        list.map((address) => ({
          chainId: "solana",
          dexId: "pumpswap",
          pairAddress: `pair-${address}`,
          baseToken: { address, symbol: "LT" },
          quoteToken: { address: "So11111111111111111111111111111111111111112", symbol: "SOL" },
          priceUsd: "0.0001",
          priceNative: "0.0000005",
          marketCap: 50_000 + Math.random() * 100_000,
          fdv: 100_000,
          liquidity: { usd: 20_000 },
          volume: { m5: 1_000, h1: 10_000, h6: 40_000, h24: 90_000 },
          txns: { m5: { buys: 10, sells: 5 }, h1: { buys: 100, sells: 60 }, h24: { buys: 900, sells: 500 } },
          priceChange: { m5: 1, h1: 5, h6: 10, h24: 20 },
        })),
      ),
    );
  }, LATENCY_MS);
}).listen(PORT, () => console.log(`stub DexScreener on :${PORT}, ${LATENCY_MS} ms per answer`));
