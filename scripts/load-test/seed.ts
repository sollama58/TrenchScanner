/**
 * Seeds a LOCAL database for the load test (scripts/load-test/README.md): USERS subscribed
 * accounts, each with FILTERS_PER_USER active filters, CHATS_PER_USER linked Telegram chats (one
 * private, the rest groups) and its own model picks, plus enough history behind them (tokens,
 * snapshots, matches, model calls) that the feed queries run against tables shaped like
 * production's rather than empty ones.
 *
 * Refuses to run against anything but localhost: it deletes and inserts in bulk.
 *
 *   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/trenchscanner \
 *     npx tsx scripts/load-test/seed.ts
 */
import { enabledContestants, loadEnv, prisma } from "@trenchscanner/core";

export const TAG = "loadtest";
const USERS = Number(process.env.LT_USERS ?? 100);
const FILTERS_PER_USER = Number(process.env.LT_FILTERS ?? 10);
const CHATS_PER_USER = Number(process.env.LT_CHATS ?? 2);
/** History: tokens, and snapshots per token. Production on 2026-10-16: 630k tokens, 3.9M snapshots. */
const TOKENS = Number(process.env.LT_TOKENS ?? 200_000);
const SNAPSHOTS_PER_TOKEN = Number(process.env.LT_SNAPSHOTS_PER_TOKEN ?? 6);
/** Matches per user over the last 30 days (production: ~207k rows for 14 filters). */
const MATCHES_PER_USER = Number(process.env.LT_MATCHES_PER_USER ?? 3_000);
/** Model calls over the last 30 days, spread across the roster. */
const CURATED_ALERTS = Number(process.env.LT_CURATED ?? 40_000);

export function assertLocal(): void {
  const url = process.env.DATABASE_URL ?? "";
  if (!/@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url)) {
    throw new Error(`load test refuses to touch a non-local database: ${url.replace(/:[^:@/]*@/, ":***@")}`);
  }
}

export function rosterIds(): string[] {
  return enabledContestants(loadEnv().CURATOR_CONTESTANTS).map((c) => c.id);
}

async function main() {
  assertLocal();
  const roster = rosterIds();
  const t0 = Date.now();
  console.log(`roster: ${roster.join(", ")}`);

  // Wipe a previous run (cascades take the filters, chats, matches and subscriptions).
  await prisma.$executeRawUnsafe(`DELETE FROM "User" WHERE "walletAddress" LIKE '${TAG}-%'`);
  await prisma.$executeRawUnsafe(`DELETE FROM "Token" WHERE "mintAddress" LIKE '${TAG}-%'`);

  // Tokens and their snapshots, in bulk.
  await prisma.$executeRawUnsafe(`
    INSERT INTO "Token" ("id", "mintAddress", "symbol", "name", "firstSeenAt", "imageUrl")
    SELECT '${TAG}-t' || g, '${TAG}-mint-' || g, 'LT' || g, 'Load test ' || g,
           now() - (random() * interval '30 days'), NULL
    FROM generate_series(1, ${TOKENS}) g`);
  await prisma.$executeRawUnsafe(`
    INSERT INTO "TokenSnapshot" ("id", "tokenId", "priceUsd", "marketCapUsd", "holderCount", "volume1hUsd", "takenAt", "rugScreenPassed")
    SELECT '${TAG}-s' || t || '-' || k, '${TAG}-t' || t, 0.0001, 20000 + random() * 500000,
           (random() * 2000)::int, random() * 100000,
           now() - (random() * interval '30 days'), random() < 0.3
    FROM generate_series(1, ${TOKENS}) t, generate_series(1, ${SNAPSHOTS_PER_TOKEN}) k`);
  console.log(`tokens+snapshots ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // Users, each subscribed, with their own model picks.
  const expires = new Date(Date.now() + 30 * 86_400_000);
  for (let u = 0; u < USERS; u++) {
    const picks = roster.filter((_, i) => (i + u) % 3 !== 0).slice(0, 1 + (u % Math.max(1, roster.length)));
    const tgPicks = roster.filter((_, i) => (i + u) % 2 === 0);
    const user = await prisma.user.create({
      data: {
        id: `${TAG}-u${u}`,
        walletAddress: `${TAG}-wallet-${u}`,
        followBestModel: u % 4 === 0,
        feedModels: picks,
        curatedModel: picks[0] ?? null,
        showModelAlerts: u % 10 !== 0,
        telegramSameAsFeed: u % 3 === 0,
        telegramModels: tgPicks,
        telegramHighConvictionOnly: u % 5 === 0,
        subscription: { create: { expiresAt: expires, source: "BURN" } },
      },
    });
    for (let f = 0; f < FILTERS_PER_USER; f++) {
      await prisma.userFilter.create({
        data: {
          id: `${TAG}-f${u}-${f}`,
          userId: user.id,
          name: `LT filter ${u}/${f}`,
          // Overlapping bands, so a hot token catches a realistic slice of everyone's filters.
          mcapMin: 5_000 + f * 5_000,
          mcapMax: 300_000 + f * 100_000 + u * 1_000,
          minScore: 40 + ((u + f) % 5) * 8,
          maxLargestHolderPct: f % 2 === 0 ? 20 + (u % 10) : null,
          maxDevWalletPct: f % 3 === 0 ? 10 : null,
          minTokenAgeMinutes: f % 4 === 0 ? 5 : null,
          maxTokenAgeMinutes: f % 4 === 1 ? 240 : null,
          maxLinkedWalletPct: f % 5 === 0 ? 30 : null,
          narrativeKeywords: f === 9 ? ["dog", "cat"] : [],
          isActive: true,
          armedAt: new Date(Date.now() - 86_400_000),
        },
      });
    }
    for (let c = 0; c < CHATS_PER_USER; c++) {
      await prisma.telegramChat.create({
        data: {
          id: `${TAG}-c${u}-${c}`,
          chatId: c === 0 ? BigInt(900_000_000 + u) : BigInt(-1_009_000_000_000 - u * 10 - c),
          kind: c === 0 ? "private" : "supergroup",
          userId: user.id,
          enabled: true,
          filterMatches: true,
          modelCalls: true,
          sentThrough: new Date(),
        },
      });
    }
  }
  console.log(`users+filters+chats ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // Each user's match history: random tokens, on their own filters, over 30 days.
  await prisma.$executeRawUnsafe(`
    INSERT INTO "Match" ("id", "userId", "filterId", "tokenId", "snapshotId", "score", "matchedAt", "deliveredDashboard")
    SELECT '${TAG}-m' || u || '-' || k, '${TAG}-u' || u, '${TAG}-f' || u || '-' || (k % ${FILTERS_PER_USER}),
           '${TAG}-t' || t, '${TAG}-s' || t || '-1', 50 + random() * 50,
           now() - interval '2 hours' - (k::float / ${MATCHES_PER_USER}) * interval '30 days', true
    FROM generate_series(0, ${USERS - 1}) u, generate_series(1, ${MATCHES_PER_USER}) k,
         LATERAL (SELECT 1 + ((u * 7919 + k * 104729) % ${TOKENS}) AS t) x
    ON CONFLICT DO NOTHING`);
  const models = `ARRAY[${roster.map((r) => `'${r}'`).join(",")}]`;
  await prisma.$executeRawUnsafe(`
    INSERT INTO "CuratedAlert" ("id", "tokenId", "snapshotId", "source", "model", "modelName", "confidence", "tier",
                                "anchorPriceUsd", "anchorMcapUsd", "reasons", "createdAt")
    SELECT '${TAG}-a' || k, '${TAG}-t' || (1 + (k * 31) % ${TOKENS}), '${TAG}-s' || (1 + (k * 31) % ${TOKENS}) || '-1',
           'curator', m, m, 0.5 + random() * 0.5, CASE WHEN random() < 0.2 THEN 'high' ELSE NULL END,
           0.0001, 50000, ARRAY['load test'],
           now() - interval '2 hours' - (k::float / ${CURATED_ALERTS}) * interval '30 days'
    FROM generate_series(1, ${CURATED_ALERTS}) k, LATERAL (SELECT (${models})[1 + k % ${roster.length}] AS m) x`);
  await prisma.$executeRawUnsafe(`ANALYZE`);
  console.log(`history done ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  await prisma.$disconnect();
}

if (process.argv[1]?.endsWith("seed.ts")) {
  main().catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
}
