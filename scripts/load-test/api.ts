/**
 * Drives a LOCAL API (started separately, see README.md) the way USERS open dashboards would,
 * against the database seed.ts filled, and prints per-route latency.
 *
 * Each simulated reader keeps both SSE nudge streams open and polls what the Live tab polls, at
 * the dashboard's own intervals (apps/web/src). On top of that, every BURST_EVERY_MS a model
 * call is "announced": every reader refetches its feed and feed stats inside the client's
 * CURATED_NUDGE_SPREAD_MS, which is the moment the whole readership lands at once.
 *
 *   API_URL=http://localhost:4011 npx tsx scripts/load-test/api.ts
 */
import { performance } from "node:perf_hooks";
import { prisma } from "@trenchscanner/core";
import { SignJWT } from "jose";
import { assertLocal, TAG } from "./seed.js";

const API = process.env.API_URL ?? "http://localhost:4011";
const USERS = Number(process.env.LT_USERS ?? 100);
const DURATION_MS = Number(process.env.LT_DURATION_MS ?? 60_000);
const BURST_EVERY_MS = Number(process.env.LT_BURST_EVERY_MS ?? 15_000);
/** apps/web/src/hooks.ts CURATED_NUDGE_SPREAD_MS. */
const NUDGE_SPREAD_MS = 3_000;
/** Poll intervals from the dashboard (path -> ms). */
const POLLS: [string, number][] = [
  ["/matches/stats?hours=24", 30_000],
  ["/health/worker", 30_000],
  ["/announcement", 30_000],
  ["/utilities", 60_000],
  ["/matches/returns", 60_000],
  ["/curated/models?days=30", 120_000],
  ["/subscription", 300_000],
];
const FEED = "/matches?page=1&includeCurated=saved";

const timings = new Map<string, number[]>();
const errors = new Map<string, number>();
const route = (path: string) => path.split("?")[0]!;

async function get(token: string, path: string): Promise<unknown> {
  const t = performance.now();
  try {
    const res = await fetch(API + path, { headers: { authorization: `Bearer ${token}` } });
    const body = await res.json().catch(() => null);
    if (!res.ok)
      errors.set(`${route(path)} ${res.status}`, (errors.get(`${route(path)} ${res.status}`) ?? 0) + 1);
    return body;
  } catch (err) {
    errors.set(`${route(path)} ${String(err).slice(0, 40)}`, (errors.get(route(path)) ?? 0) + 1);
    return null;
  } finally {
    const list = timings.get(route(path)) ?? [];
    list.push(performance.now() - t);
    timings.set(route(path), list);
  }
}

function pct(xs: number[], p: number) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0;
}

/** Sleeps, but never past the end of the run. */
let stopAt = Infinity;
const sleep = (ms: number) =>
  new Promise((r) => setTimeout(r, Math.max(0, Math.min(ms, stopAt - performance.now()))));

async function main() {
  assertLocal();
  const secret = new TextEncoder().encode(process.env.JWT_SECRET ?? "");
  const users = await prisma.user.findMany({
    where: { walletAddress: { startsWith: `${TAG}-wallet-` } },
    select: { id: true, walletAddress: true, sessionVersion: true },
    take: USERS,
  });
  const tokens = await Promise.all(
    users.map((u) =>
      new SignJWT({ walletAddress: u.walletAddress, sv: u.sessionVersion })
        .setProtectedHeader({ alg: "HS256" })
        .setSubject(u.id)
        .setIssuedAt()
        .setExpirationTime("2h")
        .sign(secret),
    ),
  );
  await prisma.$disconnect();
  console.log(
    `${users.length} readers against ${API} for ${DURATION_MS / 1000}s, a model call every ${BURST_EVERY_MS / 1000}s`,
  );

  const stop = performance.now() + DURATION_MS;
  stopAt = stop;
  const streams = new AbortController();
  // Both nudge streams per reader, held open for the run.
  for (const token of tokens) {
    for (const path of ["/matches/stream", "/curated/stream"]) {
      fetch(API + path, { headers: { authorization: `Bearer ${token}` }, signal: streams.signal })
        .then((res) => res.body?.pipeTo(new WritableStream()))
        .catch(() => undefined);
    }
  }

  const readers = tokens.map(async (token, i) => {
    // The tab opening: its feed, then each poll on its own clock, offset per reader.
    const feed = (await get(token, FEED)) as { matches?: { tokenId: string }[] } | null;
    const ids = (feed?.matches ?? []).map((m) => m.tokenId).join(",");
    const loops = [
      ...POLLS.map(async ([path, every]) => {
        await sleep((i * 997) % every);
        while (performance.now() < stop) {
          await get(token, path);
          await sleep(every);
        }
      }),
      (async () => {
        if (!ids) return;
        await sleep((i * 331) % 10_000);
        while (performance.now() < stop) {
          await get(token, `/live/market?tokens=${encodeURIComponent(ids)}`);
          await sleep(10_000);
        }
      })(),
    ];
    await Promise.all(loops);
  });

  const bursts = (async () => {
    let n = 0;
    await sleep(5_000);
    while (performance.now() < stop) {
      n += 1;
      const t = performance.now();
      const wave = timings.get("/matches")?.length ?? 0;
      await Promise.all(
        tokens.map(async (token) => {
          await sleep(Math.random() * NUDGE_SPREAD_MS);
          await Promise.all([get(token, FEED), get(token, "/matches/stats?hours=24")]);
        }),
      );
      const done = (timings.get("/matches") ?? []).slice(wave);
      console.log(
        `  burst ${n}: ${tokens.length} feed refetches done in ${((performance.now() - t) / 1000).toFixed(1)}s,` +
          ` /matches p50 ${pct(done, 50).toFixed(0)} p95 ${pct(done, 95).toFixed(0)} max ${Math.max(...done).toFixed(0)} ms`,
      );
      await sleep(Math.max(0, BURST_EVERY_MS - (performance.now() - t)));
    }
  })();

  await Promise.all([...readers, bursts]);
  streams.abort();

  console.log("\nroute                       count   p50    p95    p99    max (ms)");
  for (const [r, xs] of [...timings].sort((a, b) => pct(b[1], 95) - pct(a[1], 95))) {
    console.log(
      `${r.padEnd(26)} ${String(xs.length).padStart(6)} ${pct(xs, 50).toFixed(0).padStart(6)} ${pct(xs, 95).toFixed(0).padStart(6)}` +
        ` ${pct(xs, 99).toFixed(0).padStart(6)} ${Math.max(...xs)
          .toFixed(0)
          .padStart(6)}`,
    );
  }
  if (errors.size > 0) console.log("errors:", Object.fromEntries(errors));
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
