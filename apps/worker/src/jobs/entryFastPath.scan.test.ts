// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  buildCandidateFeatures,
  prisma,
  loadEnv,
  type CandidateToken,
  type Env,
  type RugCheckProfile,
  type ScoredToken,
} from "@trenchscanner/core";
import type { CandidateSampleRef } from "./candidateOutcomeJob.js";
import { runEntryScan, runScanCycle, setUptimeSource, type ScanDeps } from "./scanJob.js";

/** Every coin put before the curators, with the decision moment it was put there on. */
const decided = vi.hoisted(
  () => [] as { mint: string; scored: unknown; moment: { id: string; created: boolean } | null }[],
);
vi.mock("./curatedAlerts.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./curatedAlerts.js")>();
  return {
    ...actual,
    collectCuratedContender: async (...args: Parameters<typeof actual.collectCuratedContender>) => {
      decided.push({ mint: args[1].mintAddress, scored: args[2], moment: args[3] });
      return actual.collectCuratedContender(...args);
    },
  };
});

const featuresOf = (scored: unknown) =>
  buildCandidateFeatures(scored as ScoredToken) as unknown as Record<string, unknown>;

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
/** A fresh base58 address of 44 characters, ending "pump" like a Pump.fun mint. */
function address(suffix = ""): string {
  let out = "";
  while (out.length < 44 - suffix.length) out += BASE58[Math.floor(Math.random() * BASE58.length)];
  return out + suffix;
}

/** The DexScreener reading every test coin gets: young, in the band, more buys than sells. */
function reading(mintAddress: string, symbol = "FAST"): CandidateToken {
  return {
    mintAddress,
    symbol,
    name: "Fast path",
    pairAddress: address(),
    priceUsd: 0.000009,
    marketCapUsd: 9_000,
    liquidityUsd: 7_500,
    volume24hUsd: 24_000,
    buys24h: 210,
    sells24h: 60,
    priceChange5mPct: 25,
    priceChange1hPct: 80,
    volume5mUsd: 6_000,
    volume1hUsd: 24_000,
    buys5m: 70,
    sells5m: 20,
    buys1h: 210,
    sells1h: 60,
    dexId: "pumpfun",
  } as CandidateToken;
}

/** A RugCheck report that passes every local check, with a top ten to read. */
function profile(mintAddress: string, holders: string[]): RugCheckProfile {
  return {
    mintAddress,
    holderCount: 140,
    top10HolderPct: 18,
    largestHolderPct: 3,
    devWalletPct: 1,
    mintAuthorityActive: false,
    freezeAuthorityActive: false,
    lpBurned: true,
    riskScore: 1,
    riskFlags: [],
    top10HolderAddresses: holders,
    topHolderShares: holders.map((owner) => ({ owner, pct: 1.8 })),
  };
}

/**
 * The cycle and the fast scan on the same outside answers. Helius answers only the Mayhem read
 * (not Mayhem); every other read comes back empty, which each stage takes as "not known yet". The
 * decision then rests on the market reading and RugCheck's report, the same for both coins.
 */
function fakeDeps(market: Map<string, CandidateToken>, holders: Map<string, string[]>): ScanDeps {
  const refused = async () => new Map();
  const helius = new Proxy(
    {
      gtfaUsable: false,
      takeCallStats: () => ({}),
      getMayhemModeBatch: async (mints: string[]) =>
        new Map(mints.map((m) => [m, { status: "found", isMayhemMode: false }])),
    } as Record<string, unknown>,
    { get: (target, key) => (key in target ? target[key as string] : refused) },
  );
  return {
    pumpFun: {
      discoverNewMints: async () => [],
      discoverActiveMints: async () => [],
      kingOfTheHill: async () => null,
      currentlyLive: async () => null,
      liveMarketCap: async () => null,
      coinDetails: async () => null,
    },
    dexScreener: {
      discoverTrendingMints: async () => [],
      getTokensByAddresses: async (mints: string[]) =>
        mints.flatMap((m) => (market.has(m) ? [{ ...market.get(m)! }] : [])),
    },
    rugCheck: {
      getProfileResults: async (mints: string[]) =>
        new Map(
          mints.map((m) => [
            m,
            holders.has(m) ? { status: "found", profile: profile(m, holders.get(m)!) } : { status: "absent" },
          ]),
        ),
    },
    helius,
  } as unknown as ScanDeps;
}

/** A snapshot's readings, without what names the row or the moment it was taken. */
function readings(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (["id", "tokenId", "takenAt", "pairAddress"].includes(key) || value instanceof Date) continue;
    out[key] = value;
  }
  return out;
}

/**
 * The two rows read the same: every figure equal, but those that read the clock (the coin's age,
 * minutes since it entered the band) within a second, as the two passes ran moments apart.
 */
function expectSameReadings(actual: Record<string, unknown>, expected: Record<string, unknown>): void {
  expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort());
  for (const [key, value] of Object.entries(expected)) {
    const got = actual[key];
    if (typeof value === "number" && typeof got === "number" && /age|minutes/i.test(key)) {
      expect(Math.abs(got - value), key).toBeLessThan(1 / 60);
    } else {
      expect(got, key).toEqual(value);
    }
  }
}

describe.skipIf(!dbAvailable)("the entry fast path's first scan", () => {
  const created: string[] = [];
  // Long past a boot: the hourly samples below don't wait for a live-tape page (BOOT_TAPE_WARMUP_SECONDS).
  setUptimeSource(() => 3_600);
  afterAll(async () => {
    setUptimeSource();
    if (!dbAvailable) return;
    await prisma.token.deleteMany({ where: { mintAddress: { in: created } } });
  });

  it("screens, scores and decides a coin as the cycle does, banks it as an entry row, and leaves the event to the cycle", async () => {
    const env: Env = {
      ...loadEnv(),
      // The decision moment is banked on the market reading and the report alone: the wallet
      // checks, which these fakes never answer, would hold it otherwise.
      CURATED_REQUIRE_WALLET_CHECKS: false,
      TOKENSAGE_ENABLED: false,
    };
    const market = new Map<string, CandidateToken>();
    const holders = new Map<string, string[]>();
    const deps = fakeDeps(market, holders);
    // The same top ten on both coins, so their holder readings match to the wallet.
    const topTen = Array.from({ length: 10 }, () => address());
    // Each its own ticker: a coin launched just before under the same one is a relaunch-farm input.
    const seed = async (mint: string, symbol: string) => {
      created.push(mint);
      market.set(mint, reading(mint, symbol));
      holders.set(mint, topTen);
      const at = new Date(Date.now() - 2 * 60_000);
      await prisma.token.create({
        data: { mintAddress: mint, symbol, firstSeenAt: at, launchedAt: at, launchpad: "pumpfun" },
      });
    };

    // The cycle's coin first, so the fast scan reads the market context of a cycle before it.
    const cycleMint = address("pump");
    await seed(cycleMint, `C${cycleMint.slice(0, 5)}`);
    await runScanCycle(deps, env);
    const fastMint = address("pump");
    await seed(fastMint, `F${fastMint.slice(0, 5)}`);
    const result = await runEntryScan(deps, env, fastMint);
    expect(result.skipped).toBeUndefined();

    const firstSnapshot = (mint: string) =>
      prisma.tokenSnapshot.findFirstOrThrow({
        where: { token: { mintAddress: mint } },
        orderBy: { takenAt: "asc" },
      });
    const [cycleSnapshot, fastSnapshot] = await Promise.all([
      firstSnapshot(cycleMint),
      firstSnapshot(fastMint),
    ]);
    expectSameReadings(readings(fastSnapshot), readings(cycleSnapshot));
    expect(fastSnapshot.rugScreenPassed).toBe(true);

    // Both went before the curators on the same model inputs: the cycle's coin on the event row it
    // banked, the fast scan's on the entry row it banked (its own kind, user decision 2026-10-26).
    const cycleDecision = decided.find((d) => d.mint === cycleMint);
    const fastDecision = decided.find((d) => d.mint === fastMint);
    expect(cycleDecision?.moment?.created).toBe(true);
    expect(fastDecision).toBeDefined();
    expect(fastDecision!.moment?.created).toBe(true);
    expectSameReadings(featuresOf(fastDecision!.scored), featuresOf(cycleDecision!.scored));

    const samples = (mint: string) =>
      prisma.candidateOutcome.findMany({
        where: { token: { mintAddress: mint } },
        select: { id: true, sampleKind: true, anchorMcapUsd: true, features: true, seatScores: true },
        orderBy: { sampleKind: "asc" },
      });
    // The fast scan banked the entry row alone, with every seat's score on it; the coin's decision
    // moment (its event) is still the cycle's to take.
    const entryRows = await samples(fastMint);
    expect(entryRows.map((s) => s.sampleKind)).toEqual(["entry"]);
    expect(entryRows[0]!.id).toBe(fastDecision!.moment!.id);
    // (Only Rules sits here, and it stores no probability; curatedAlerts.test.ts covers a seat's
    // score landing on the entry row.)

    // The next cycle reaches the coin on schedule and banks its decision moment (and its hourly
    // training sample) as it would have without the fast scan, and every seat decides there again.
    await runScanCycle(deps, env);
    const [cycleSamples, fastAll] = await Promise.all([samples(cycleMint), samples(fastMint)]);
    expect(fastAll.map((s) => s.sampleKind)).toEqual(["entry", "event", "hourly"]);
    expect(cycleSamples.map((s) => s.sampleKind)).toEqual(["event", "hourly"]);
    const fastSamples = fastAll.filter((s) => s.sampleKind !== "entry");
    // On the coin's own readings, as the first coin's were; the market context (mkt*) counts both
    // coins in the band now, where the first cycle had one.
    const ownReadings = (features: unknown) =>
      Object.fromEntries(
        Object.entries(features as Record<string, unknown>).filter(([key]) => !key.startsWith("mkt")),
      );
    fastSamples.forEach((s, i) => {
      expect(s.anchorMcapUsd).toBe(cycleSamples[i]!.anchorMcapUsd);
      expectSameReadings(ownReadings(s.features), ownReadings(cycleSamples[i]!.features));
    });
    const event = fastSamples.find((s) => s.sampleKind === "event")!;
    const later = decided.filter((d) => d.mint === fastMint);
    expect(later).toHaveLength(2);
    expect(later[1]!.moment).toEqual<CandidateSampleRef>({ id: event.id, created: true });
  }, 90_000);

  it("records a launch still buffered on the stream before scanning it", async () => {
    const env: Env = { ...loadEnv(), TOKENSAGE_ENABLED: false };
    const mint = address("pump");
    created.push(mint);
    const market = new Map([[mint, reading(mint)]]);
    const deps: ScanDeps = {
      ...fakeDeps(market, new Map([[mint, Array.from({ length: 10 }, () => address())]])),
      stream: {
        drain: () => [],
        pendingLaunch: (m) =>
          m === mint
            ? {
                kind: "create",
                mintAddress: mint,
                symbol: "NEW",
                name: "New",
                launchpad: "pumpfun",
                at: new Date(),
              }
            : undefined,
      },
    };
    const result = await runEntryScan(deps, env, mint);
    expect(result.skipped).toBeUndefined();
    const token = await prisma.token.findUniqueOrThrow({ where: { mintAddress: mint } });
    expect(token.discoverySource).toBe("pumpportal");
    expect(await prisma.tokenSnapshot.count({ where: { tokenId: token.id } })).toBe(1);
  }, 60_000);

  it("scans nothing for a coin it has no row or launch for", async () => {
    const env: Env = { ...loadEnv(), TOKENSAGE_ENABLED: false };
    const deps = fakeDeps(new Map(), new Map());
    expect((await runEntryScan(deps, env, address("pump"))).skipped).toBe("noRow");
  });
});
