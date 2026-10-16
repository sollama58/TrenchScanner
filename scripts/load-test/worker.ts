/**
 * Times the worker's per-user paths against the seeded local database (seed.ts):
 *
 *   1. loading every matchable filter (what the scan and the fast lane do every cycle),
 *   2. one scan cycle's matching: CANDIDATES scored tokens, CANDIDATE_CONCURRENCY at a time,
 *      each checked against every filter and alerted where it matches,
 *   3. Telegram delivery of what that produced, plus model calls that reach every chat whose
 *      picks include the model, over a fake Bot API that answers after TG_LATENCY_MS.
 *
 * Never talks to Telegram or any outside API; refuses a non-local database.
 *
 *   npx tsx scripts/load-test/worker.ts
 */
import { performance } from "node:perf_hooks";
import {
  TelegramApi,
  loadEnv,
  matchesFilter,
  prisma,
  runTelegramDispatch,
  type FeedModelState,
  type TelegramResult,
  type ScoredToken,
  enabledContestants,
} from "@trenchscanner/core";
import {
  createMatchesForTargets,
  loadMatchableFilters,
  resolveAlertTargets,
} from "../../apps/worker/src/jobs/matchDispatch.js";
import type { Token, TokenSnapshot } from "@prisma/client";
import { snapshotDataFor } from "../../apps/worker/src/jobs/snapshotData.js";
import { assertLocal, TAG } from "./seed.js";

const CANDIDATES = Number(process.env.LT_CANDIDATES ?? 300);
/**
 * How many of the cycle's candidates are hot enough to pass most filters - a busy minute. The
 * rest score low enough that only the loosest filters (minScore 40) catch a few of them.
 */
const HOT = Number(process.env.LT_HOT ?? 5);
const CALLS = Number(process.env.LT_CALLS ?? 3);
const CONCURRENCY = 15;
const TG_LATENCY_MS = Number(process.env.LT_TG_LATENCY_MS ?? 80);

/** A Bot API that answers ok after TG_LATENCY_MS and records every send; it never fetches artwork. */
class SlowFakeTelegram extends TelegramApi {
  readonly chats: string[] = [];
  readonly sentAt: number[] = [];
  constructor() {
    super(
      "fake-token",
      () => Promise.reject(new Error("the fake never fetches")),
      async () => ["93.184.216.34"],
    );
  }
  override async call<T>(method: string, params: Record<string, unknown> = {}): Promise<TelegramResult<T>> {
    await new Promise((r) => setTimeout(r, TG_LATENCY_MS));
    if (method === "sendMessage" || method === "sendPhoto") {
      this.chats.push(String(params.chat_id));
      this.sentAt.push(performance.now());
    }
    return { ok: true, result: { message_id: 1 } as T };
  }
}

function scored(mint: string, hot: boolean, i: number): ScoredToken {
  return {
    mintAddress: mint,
    priceUsd: 0.0001,
    marketCapUsd: hot ? 120_000 : 2_000 + (i % 50) * 30_000,
    liquidityUsd: 40_000,
    volume24hUsd: 200_000,
    volumeToMcapRatio: 1.3,
    buys24h: 700,
    sells24h: 300,
    ageMinutes: 30 + (i % 300),
    graduated: true,
    narrativeTags: [],
    largestHolderPct: hot ? 8 : 15 + (i % 30),
    devWalletPct: hot ? 2 : i % 20,
    linkedWalletPct: hot ? 5 : i % 60,
    rugScreen: { passed: true, reasons: [] },
    score: { momentum: 85, holderHealth: 75, age: 100, narrative: 40, total: hot ? 90 : 20 + (i % 25) },
  } as ScoredToken;
}

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (next < items.length) await fn(items[next++]!);
    }),
  );
}

function pct(xs: number[], p: number) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0;
}

async function main() {
  assertLocal();
  const env = { ...loadEnv(), TELEGRAM_BOT_TOKEN: "123456:load-test-fake-token" };
  const run = `${TAG}-run${Date.now()}`;

  // 1. Filters.
  let t = performance.now();
  const filters = await loadMatchableFilters(env);
  console.log(`loadMatchableFilters: ${filters.length} filters in ${(performance.now() - t).toFixed(0)} ms`);

  // Fresh candidate tokens, with the snapshot the scan would have written.
  const cands: { token: Token; snap: TokenSnapshot; s: ScoredToken }[] = [];
  for (let i = 0; i < CANDIDATES; i++) {
    const hot = i < HOT;
    const token = await prisma.token.create({
      data: { mintAddress: `${run}-${i}`, symbol: `C${i}`, firstSeenAt: new Date(Date.now() - 3_600_000) },
    });
    const s = scored(token.mintAddress, hot, i);
    const snap = await prisma.tokenSnapshot.create({ data: snapshotDataFor(token.id, s, "scan") });
    cands.push({ token, snap, s });
  }
  // Everything since now is news to every chat.
  const since = new Date(Date.now() - 500);
  await prisma.telegramChat.updateMany({
    where: { id: { startsWith: `${TAG}-c` } },
    data: { sentThrough: since },
  });

  // 2. One scan cycle's matching.
  const resolveMs: number[] = [];
  const createMs: number[] = [];
  let created = 0;
  t = performance.now();
  await pool(cands, CONCURRENCY, async (c) => {
    const a = performance.now();
    const toAlert = await resolveAlertTargets({
      tokenId: c.token.id,
      tokenFirstSeenAt: c.token.firstSeenAt,
      scored: c.s,
      activeFilters: filters,
    });
    resolveMs.push(performance.now() - a);
    if (toAlert.length === 0) return;
    const b = performance.now();
    const n = await createMatchesForTargets({ token: c.token, snapshot: c.snap, scored: c.s, toAlert, env });
    created += n;
    createMs.push(performance.now() - b);
  });
  const cycleMs = performance.now() - t;
  // The pure in-memory part, for scale: every filter against every candidate.
  const a = performance.now();
  for (const c of cands) for (const f of filters) matchesFilter(c.s, f);
  const inMemoryMs = performance.now() - a;
  console.log(
    `matching: ${CANDIDATES} candidates x ${filters.length} filters in ${cycleMs.toFixed(0)} ms` +
      ` (in-memory filter checks alone ${inMemoryMs.toFixed(0)} ms); ${created} matches created`,
  );
  console.log(
    `  resolveAlertTargets p50 ${pct(resolveMs, 50).toFixed(1)} p95 ${pct(resolveMs, 95).toFixed(1)} ms;` +
      ` createMatchesForTargets (${createMs.length} tokens) p50 ${pct(createMs, 50).toFixed(1)} p95 ${pct(createMs, 95).toFixed(1)} max ${Math.max(0, ...createMs).toFixed(0)} ms`,
  );

  // 3. Model calls: CALLS calls from different models, each on its own hot token.
  const roster = enabledContestants(env.CURATOR_CONTESTANTS);
  for (let i = 0; i < CALLS; i++) {
    const c = cands[i]!;
    await prisma.curatedAlert.create({
      data: {
        tokenId: c.token.id,
        snapshotId: c.snap.id,
        source: "curator",
        model: roster[i % roster.length]!.id,
        modelName: roster[i % roster.length]!.id,
        confidence: 0.9,
        anchorPriceUsd: 0.0001,
        anchorMcapUsd: 120_000,
        reasons: ["load test"],
      },
    });
  }
  await new Promise((r) => setTimeout(r, Number(process.env.LT_PAUSE_MS ?? 1_200))); // past COMMIT_GRACE_MS
  const state: FeedModelState = {
    roster,
    defaultModel: roster[0]!.id,
    defaultModels: roster.slice(0, 3).map((c) => c.id),
    bestModel: null,
  };
  const api = new SlowFakeTelegram();
  let passes = 0;
  let sent = 0;
  const passMs: number[] = [];
  t = performance.now();
  for (; passes < 20; passes++) {
    const a = performance.now();
    const summary = await runTelegramDispatch(env, {
      api,
      feedModelState: async () => state,
      narrativeNoteReady: async () => false,
      oldestOpenTransaction: async () => null,
    });
    passMs.push(performance.now() - a);
    const first = api.sentAt.find((x) => x >= a);
    const last = api.sentAt.filter((x) => x >= a).pop();
    if (first !== undefined && last !== undefined) {
      console.log(
        `  pass ${passes + 1}: first send ${(first - a - TG_LATENCY_MS).toFixed(0)} ms after the pass began,` +
          ` last ${(last - a).toFixed(0)} ms`,
      );
    }
    sent += summary.sent + summary.digests;
    console.log(
      `  dispatch pass ${passes + 1}: ${summary.chats} chats, sent ${summary.sent} (${summary.digests} digests),` +
        ` failed ${summary.failed}, ${(performance.now() - a).toFixed(0)} ms`,
    );
    const behind = await prisma.telegramChat.count({
      where: { id: { startsWith: `${TAG}-c` }, sentThrough: { lt: new Date(Date.now() - 2_000) } },
    });
    if (summary.sent === 0 && behind === 0) break;
  }
  console.log(
    `telegram: ${sent} messages to ${new Set(api.chats).size} chats over ${passes + 1} passes,` +
      ` ${((performance.now() - t) / 1000).toFixed(1)} s end to end (fake API answering in ${TG_LATENCY_MS} ms)`,
  );

  if (!process.env.LT_KEEP) await prisma.token.deleteMany({ where: { mintAddress: { startsWith: run } } });
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
