// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { readFileSync } from "node:fs";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  prisma,
  loadEnv,
  HttpError,
  TOKENSAGE_PREFETCH_CHUNK,
  type Env,
  type TokenSageClient,
} from "@trenchscanner/core";
import {
  flushNarrativeRequests,
  noteNarrativeWanted,
  resetTokenSage,
  setFlushDeadlineForTest,
  startNarrativePolling,
  takeTokenSageStats,
} from "./prefetch.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const TAG = `ts-test-${Date.now()}`;

function fakeClient() {
  const batch = vi.fn();
  const job = vi.fn();
  return { client: { batch, job } as unknown as TokenSageClient, batch, job };
}

const ok = (items: unknown[], fullRemaining: number | null = null) => ({ items, fullRemaining });

const analysis = (mint: string, depth: "basic" | "full") => ({
  mint,
  depth,
  analyzed_at: new Date().toISOString(),
  categories: [{ label: "animal/dog", confidence: 0.8 }],
  flags: [{ code: "copycat", severity: "warn" }],
  summary: "A dog coin",
  versions: { rules: "0.6.0-full" },
  ...(depth === "full" ? { x: { match: { fit: 0.96, verdict: "about_this_coin" } } } : {}),
});

const cas = (call: unknown[]) => (call[0] as { ca: string }[]).map((e) => e.ca);

describe.skipIf(!dbAvailable)("TokenSage prefetch", () => {
  const base = dbAvailable ? loadEnv() : (undefined as never);
  const env: Env = dbAvailable
    ? { ...base, TOKENSAGE_ENABLED: true, TOKENSAGE_API_URL: "https://ts.test", TOKENSAGE_API_KEY: "k" }
    : base;

  beforeEach(() => resetTokenSage());
  afterAll(async () => {
    if (!dbAvailable) return;
    await prisma.tokenNarrative.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
  });

  it("does nothing while switched off", async () => {
    const { client, batch } = fakeClient();
    const off = { ...env, TOKENSAGE_ENABLED: false };
    noteNarrativeWanted(`${TAG}-off`, "basic", off);
    await flushNarrativeRequests(off, client);
    expect(batch).not.toHaveBeenCalled();
  });

  it("abandons a flush that never finishes, so the next one still sends", async () => {
    // 2026-10-08: one flush never returned and every later one was a no-op for an hour.
    const { client, batch } = fakeClient();
    const a = `${TAG}-hung-a`;
    const b = `${TAG}-hung-b`;
    setFlushDeadlineForTest(50);
    batch.mockReturnValueOnce(new Promise(() => {}));
    noteNarrativeWanted(a, "basic", env);
    await flushNarrativeRequests(env, client);
    expect(takeTokenSageStats()).toMatchObject({ hung: 1, errors: 1 });

    batch.mockResolvedValueOnce(ok([{ ca: b, status: "complete", analysis: analysis(b, "basic") }]));
    noteNarrativeWanted(b, "basic", env);
    await flushNarrativeRequests(env, client);
    expect(batch).toHaveBeenCalledTimes(2);
    expect(cas(batch.mock.calls[1]!)).toContain(b);
    expect(await prisma.tokenNarrative.count({ where: { mintAddress: b } })).toBe(1);
  });

  it("sends hints, stores cached answers, and re-sends queued ones instead of polling", async () => {
    const { client, batch } = fakeClient();
    const a = `${TAG}-a`;
    const b = `${TAG}-b`;
    batch.mockResolvedValueOnce(
      ok([
        { ca: a, status: "complete", analysis: analysis(a, "basic") },
        { ca: b, status: "pending", job_id: 7 },
      ]),
    );
    noteNarrativeWanted(a, "basic", env, { name: "Dog", symbol: "DOG" });
    noteNarrativeWanted(b, "basic", env);
    await flushNarrativeRequests(env, client);
    expect(batch.mock.calls[0]![0]).toEqual([
      { ca: a, hints: { name: "Dog", symbol: "DOG" }, priority: "normal" },
      { ca: b, priority: "normal" },
    ]);
    expect(batch.mock.calls[0]![1]).toBe("basic");
    const rowA = await prisma.tokenNarrative.findUniqueOrThrow({ where: { mintAddress: a } });
    expect(rowA).toMatchObject({
      depth: "basic",
      status: "complete",
      flags: ["copycat"],
      summary: "A dog coin",
    });

    // Next cycle: both are noted again; a is settled, b is re-sent (free on TokenSage's side).
    batch.mockResolvedValueOnce(ok([{ ca: b, status: "complete", analysis: analysis(b, "basic") }]));
    noteNarrativeWanted(a, "basic", env);
    noteNarrativeWanted(b, "basic", env);
    await flushNarrativeRequests(env, client);
    expect(cas(batch.mock.calls[1]!)).toEqual([b]);
    expect(await prisma.tokenNarrative.count({ where: { mintAddress: b } })).toBe(1);
    // b counts once as requested, not once per re-send.
    expect(takeTokenSageStats()).toMatchObject({ requested: 2, stored: 2, pending: 0 });

    // Nothing left to send.
    noteNarrativeWanted(b, "basic", env);
    await flushNarrativeRequests(env, client);
    expect(batch).toHaveBeenCalledTimes(2);
  });

  it("upgrades to full depth, keeps the X match, and never lets a basic answer overwrite it", async () => {
    const { client, batch } = fakeClient();
    const c = `${TAG}-c`;
    batch.mockResolvedValueOnce(ok([{ ca: c, status: "complete", analysis: analysis(c, "full") }]));
    noteNarrativeWanted(c, "basic", env);
    noteNarrativeWanted(c, "full", env);
    await flushNarrativeRequests(env, client);
    expect(cas(batch.mock.calls[0]!)).toEqual([c]);
    expect(batch.mock.calls[0]![1]).toBe("full");
    const row = await prisma.tokenNarrative.findUniqueOrThrow({ where: { mintAddress: c } });
    expect(row).toMatchObject({ depth: "full", xFit: 0.96, xVerdict: "about_this_coin" });

    resetTokenSage();
    noteNarrativeWanted(c, "basic", env);
    await flushNarrativeRequests(env, client);
    // Already stored at full depth: not even sent.
    expect(batch).toHaveBeenCalledTimes(1);
  });

  it("falls back to basic once the full-depth quota is spent", async () => {
    const { client, batch } = fakeClient();
    const d1 = `${TAG}-d1`;
    const d2 = `${TAG}-d2`;
    batch.mockResolvedValueOnce(ok([{ ca: d1, status: "pending", job_id: 1 }], 0));
    noteNarrativeWanted(d1, "full", env);
    await flushNarrativeRequests(env, client);

    batch.mockResolvedValue(ok([]));
    noteNarrativeWanted(d2, "full", env);
    await flushNarrativeRequests(env, client);
    // d1's full job is not re-sent while full is blocked; d2 goes as basic.
    const last = batch.mock.calls.at(-1)!;
    expect(last[1]).toBe("basic");
    expect(cas(last)).toEqual([d2]);
  });

  it("re-queues an item turned away for quota and keeps the rest of the batch", async () => {
    const { client, batch } = fakeClient();
    const e1 = `${TAG}-e1`;
    const e2 = `${TAG}-e2`;
    batch.mockResolvedValueOnce(
      ok([
        { ca: e1, status: "complete", analysis: analysis(e1, "full") },
        { ca: e2, status: "failed", error: "quota_exceeded", retry_after_s: 3600 },
      ]),
    );
    noteNarrativeWanted(e1, "full", env);
    noteNarrativeWanted(e2, "full", env);
    await flushNarrativeRequests(env, client);
    expect(await prisma.tokenNarrative.count({ where: { mintAddress: e2 } })).toBe(0);
    // Only e1 started a job: e2 was turned away, so it costs no request and no full budget.
    expect(takeTokenSageStats()).toMatchObject({ stored: 1, turnedAway: 1, requested: 1, fullToday: 1 });

    batch.mockResolvedValueOnce(ok([]));
    await flushNarrativeRequests(env, client);
    const last = batch.mock.calls.at(-1)!;
    expect(last[1]).toBe("basic");
    expect(cas(last)).toEqual([e2]);
  });

  it("caches definitive failures and pauses after a 429", async () => {
    const { client, batch } = fakeClient();
    const f = `${TAG}-f`;
    batch.mockRejectedValueOnce(new HttpError(429, "https://ts.test/v1/tokens:batch"));
    noteNarrativeWanted(f, "basic", env);
    await flushNarrativeRequests(env, client);
    await flushNarrativeRequests(env, client);
    expect(batch).toHaveBeenCalledTimes(1);

    resetTokenSage();
    batch.mockResolvedValueOnce(ok([{ ca: f, status: "invalid", error: "not a mint" }]));
    noteNarrativeWanted(f, "basic", env);
    await flushNarrativeRequests(env, client);
    expect((await prisma.tokenNarrative.findUniqueOrThrow({ where: { mintAddress: f } })).status).toBe(
      "failed",
    );
  });

  it("pauses after TokenSage rejects the key, instead of retrying every poll", async () => {
    const { client, batch } = fakeClient();
    batch.mockRejectedValueOnce(new HttpError(401, "https://ts.test/v1/tokens:batch"));
    noteNarrativeWanted(`${TAG}-k`, "basic", env);
    await flushNarrativeRequests(env, client);
    await flushNarrativeRequests(env, client);
    expect(batch).toHaveBeenCalledTimes(1);
  });

  it("asks again for a partial answer, a few times", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { client, batch } = fakeClient();
      const g = `${TAG}-g`;
      batch.mockResolvedValue(ok([{ ca: g, status: "partial", analysis: analysis(g, "basic") }]));
      noteNarrativeWanted(g, "basic", env);
      await flushNarrativeRequests(env, client);
      noteNarrativeWanted(g, "basic", env);
      await flushNarrativeRequests(env, client);
      expect(batch).toHaveBeenCalledTimes(1);
      for (let i = 0; i < 5; i += 1) {
        vi.setSystemTime(Date.now() + 100_000);
        noteNarrativeWanted(g, "basic", env);
        await flushNarrativeRequests(env, client);
      }
      // The first answer plus three retries, then it stops.
      expect(batch).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends every deep read asked for: no daily cap of our own", async () => {
    const { client, batch } = fakeClient();
    batch.mockResolvedValue(ok([]));
    const many = Array.from({ length: 30 }, (_, i) => `${TAG}-h${i}`);
    for (const m of many) noteNarrativeWanted(m, "full", env);
    await flushNarrativeRequests(env, client);
    const fullSent = batch.mock.calls.filter((c) => c[1] === "full").flatMap(cas);
    expect(fullSent.sort()).toEqual([...many].sort());
  });

  it("reads why a re-sent mint's job ended, and stops asking for a definitive failure", async () => {
    const { client, batch, job } = fakeClient();
    const k = `${TAG}-k`;
    const m = `${TAG}-m`;
    batch.mockResolvedValueOnce(
      ok([
        { ca: k, status: "pending", job_id: 11 },
        { ca: m, status: "pending", job_id: 21 },
      ]),
    );
    noteNarrativeWanted(k, "full", env);
    noteNarrativeWanted(m, "full", env);
    await flushNarrativeRequests(env, client);

    // Re-sent: both come back under new jobs, so the old ones ended without an analysis.
    batch.mockResolvedValueOnce(
      ok([
        { ca: k, status: "pending", job_id: 12 },
        { ca: m, status: "pending", job_id: 22 },
      ]),
    );
    job.mockImplementation(async (id: number) =>
      id === 11
        ? { job_id: 11, status: "failed", error: "not_pumpfun: no bonding curve" }
        : { job_id: 21, status: "failed", error: "token_not_found: no account found on-chain" },
    );
    await flushNarrativeRequests(env, client);
    expect(job.mock.calls.map((c) => c[0]).sort()).toEqual([11, 21]);
    expect((await prisma.tokenNarrative.findUniqueOrThrow({ where: { mintAddress: k } })).status).toBe(
      "failed",
    );
    expect(await prisma.tokenNarrative.count({ where: { mintAddress: m } })).toBe(0);
    expect(takeTokenSageStats()).toMatchObject({ pending: 0 });

    // Neither is sent again: k is settled, m is cooling off.
    noteNarrativeWanted(k, "full", env);
    noteNarrativeWanted(m, "full", env);
    await flushNarrativeRequests(env, client);
    expect(batch).toHaveBeenCalledTimes(2);
  });

  it("keeps a basic read's document only once the coin has reached the band", async () => {
    const { client, batch } = fakeClient();
    const outside = `${TAG}-doc-outside`;
    const inBand = `${TAG}-doc-inband`;
    const noToken = `${TAG}-doc-notoken`;
    await prisma.token.deleteMany({ where: { mintAddress: { in: [outside, inBand] } } });
    await prisma.token.create({ data: { mintAddress: outside } });
    await prisma.token.create({ data: { mintAddress: inBand, firstInBandAt: new Date() } });
    batch.mockResolvedValueOnce(
      ok([
        { ca: outside, status: "complete", analysis: analysis(outside, "basic") },
        { ca: inBand, status: "complete", analysis: analysis(inBand, "basic") },
        { ca: noToken, status: "complete", analysis: analysis(noToken, "basic") },
      ]),
    );
    noteNarrativeWanted(outside, "basic", env);
    noteNarrativeWanted(inBand, "basic", env);
    noteNarrativeWanted(noToken, "basic", env);
    await flushNarrativeRequests(env, client);
    const rows = await prisma.tokenNarrative.findMany({
      where: { mintAddress: { in: [outside, inBand, noToken] } },
      orderBy: { mintAddress: "asc" },
      select: { mintAddress: true, analysis: true, status: true, categories: true },
    });
    // The derived columns land for all three; the document only where the coin is in the band.
    expect(rows.map((r) => [r.mintAddress, r.status, r.analysis !== null, r.categories !== null])).toEqual([
      [inBand, "complete", true, true],
      [noToken, "complete", false, true],
      [outside, "complete", false, true],
    ]);
    // A full read keeps its document whatever the coin's band history.
    batch.mockResolvedValueOnce(
      ok([{ ca: outside, status: "complete", analysis: analysis(outside, "full") }]),
    );
    noteNarrativeWanted(outside, "full", env);
    await flushNarrativeRequests(env, client);
    const full = await prisma.tokenNarrative.findUniqueOrThrow({ where: { mintAddress: outside } });
    expect(full.depth).toBe("full");
    expect(full.analysis).not.toBeNull();
    await prisma.token.deleteMany({ where: { mintAddress: { in: [outside, inBand] } } });
  });

  it("gives an imageless Token row the logo TokenSage resolved, and never replaces one", async () => {
    const { client, batch } = fakeClient();
    const bare = `${TAG}-img-bare`;
    const named = `${TAG}-img-named`;
    const has = `${TAG}-img-has`;
    await prisma.token.deleteMany({ where: { mintAddress: { in: [bare, named, has] } } });
    await prisma.token.create({ data: { mintAddress: bare } });
    await prisma.token.create({ data: { mintAddress: named } });
    await prisma.token.create({ data: { mintAddress: has, imageUrl: "https://ipfs.io/ipfs/mine" } });
    const logo = (mint: string, image: unknown, raw: unknown) => ({ ...analysis(mint, "basic"), image, raw });
    batch.mockResolvedValueOnce(
      ok([
        {
          ca: bare,
          status: "complete",
          analysis: logo(
            bare,
            { status: "ok", source_url: "https://cdn.example/ok.png" },
            { image_url: "https://x/raw.png" },
          ),
        },
        // The fetch failed on TokenSage's side: the URL the metadata names is still the best we have.
        {
          ca: named,
          status: "complete",
          analysis: logo(
            named,
            { status: "failed", source_url: "https://cdn.example/f.png" },
            { image_url: "https://cdn.example/f.png" },
          ),
        },
        {
          ca: has,
          status: "complete",
          analysis: logo(has, { status: "ok", source_url: "https://cdn.example/other.png" }, null),
        },
      ]),
    );
    for (const m of [bare, named, has]) noteNarrativeWanted(m, "basic", env);
    await flushNarrativeRequests(env, client);
    const rows = await prisma.token.findMany({
      where: { mintAddress: { in: [bare, named, has] } },
      orderBy: { mintAddress: "asc" },
      select: { mintAddress: true, imageUrl: true },
    });
    expect(rows).toEqual([
      { mintAddress: bare, imageUrl: "https://cdn.example/ok.png" },
      { mintAddress: has, imageUrl: "https://ipfs.io/ipfs/mine" },
      { mintAddress: named, imageUrl: "https://cdn.example/f.png" },
    ]);
    await prisma.token.deleteMany({ where: { mintAddress: { in: [bare, named, has] } } });
  });

  it("stores a real TokenSage answer under the CA we asked about, and survives odd items", async () => {
    const { client, batch } = fakeClient();
    const real = JSON.parse(
      readFileSync(
        new URL("../../../../packages/core/src/datasources/fixtures/tokensage/full.json", import.meta.url),
        "utf8",
      ),
    ) as { analysis: Record<string, unknown> };
    const n = `${TAG}-n`;
    const p = `${TAG}-p`;
    const q = `${TAG}-q`;
    batch.mockResolvedValueOnce(
      ok([
        null,
        // The document's own mint is TokenSage's; the row is keyed by our CA.
        { ca: n, status: "complete", analysis: { ...real.analysis, summary: "nul\u0000here" } },
        // Done but no document, and a status this version doesn't know: both cool off.
        { ca: p, status: "complete", analysis: null },
        { ca: q, status: "rejected" },
      ]),
    );
    noteNarrativeWanted(n, "full", env);
    noteNarrativeWanted(p, "full", env);
    noteNarrativeWanted(q, "full", env);
    await flushNarrativeRequests(env, client);
    const row = await prisma.tokenNarrative.findUniqueOrThrow({ where: { mintAddress: n } });
    expect(row).toMatchObject({
      depth: "full",
      status: "complete",
      xFit: 0,
      xVerdict: "unrelated",
      referentLabel: "Peanut (squirrel)",
      summary: "nulhere",
    });
    expect(row.flags).toContain("x_content_mismatch");
    expect((row.analysis as { x: { match: { verdict: string } } }).x.match.verdict).toBe("unrelated");
    expect(await prisma.tokenNarrative.count({ where: { mintAddress: { in: [p, q] } } })).toBe(0);
    expect(takeTokenSageStats()).toMatchObject({ stored: 1, pending: 0, errors: 0 });

    noteNarrativeWanted(p, "full", env);
    noteNarrativeWanted(q, "full", env);
    await flushNarrativeRequests(env, client);
    expect(batch).toHaveBeenCalledTimes(1);
  });

  it("stores the new fields from a real paired-coin answer", async () => {
    const { client, batch } = fakeClient();
    const real = JSON.parse(
      readFileSync(
        new URL(
          "../../../../packages/core/src/datasources/fixtures/tokensage/paired_token.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as { analysis: Record<string, unknown> };
    const r = `${TAG}-r`;
    batch.mockResolvedValueOnce(ok([{ ca: r, status: "complete", analysis: real.analysis }]));
    noteNarrativeWanted(r, "full", env);
    await flushNarrativeRequests(env, client);
    expect(await prisma.tokenNarrative.findUniqueOrThrow({ where: { mintAddress: r } })).toMatchObject({
      referentLabel: "Bonk",
      referentConfidence: 0.97,
      referentSupport: ["name", "chain"],
      pairKind: "token",
      pairSymbol: "BONK",
      copiesRecent: false,
      failReason: null,
    });
  });

  it("leaves a failed analysis alone for TokenSage's 10 minutes, and gives up after a few", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { client, batch } = fakeClient();
      const s1 = `${TAG}-s1`;
      const s2 = `${TAG}-s2`;
      const rpcDown =
        "tokensage.resolve.rpc.RpcError: rpc transport error; retried automatically after 600 s";
      batch.mockResolvedValue(
        ok([
          { ca: s1, status: "failed", analysis: null, job_id: 7, error: rpcDown },
          { ca: s2, status: "failed", analysis: null, job_id: 8, error: "not_pumpfun: no bonding curve" },
        ]),
      );
      noteNarrativeWanted(s1, "basic", env);
      noteNarrativeWanted(s2, "basic", env);
      await flushNarrativeRequests(env, client);
      // Definitive: cached with its reason. Transient: nothing stored yet.
      expect(await prisma.tokenNarrative.findUniqueOrThrow({ where: { mintAddress: s2 } })).toMatchObject({
        status: "failed",
        failReason: "not_pumpfun: no bonding curve",
      });
      expect(await prisma.tokenNarrative.count({ where: { mintAddress: s1 } })).toBe(0);

      // Within the window: not asked again.
      vi.setSystemTime(Date.now() + 5 * 60_000);
      noteNarrativeWanted(s1, "basic", env);
      await flushNarrativeRequests(env, client);
      expect(batch).toHaveBeenCalledTimes(1);

      // After it, asked again; the third failure is cached.
      for (let i = 0; i < 2; i += 1) {
        vi.setSystemTime(Date.now() + 12 * 60_000);
        noteNarrativeWanted(s1, "basic", env);
        await flushNarrativeRequests(env, client);
      }
      expect(batch).toHaveBeenCalledTimes(3);
      expect(cas(batch.mock.calls[2]!)).toEqual([s1]);
      const row = await prisma.tokenNarrative.findUniqueOrThrow({ where: { mintAddress: s1 } });
      expect(row).toMatchObject({ status: "failed", failReason: rpcDown });
    } finally {
      vi.useRealTimers();
    }
  });

  it("caches a job whose TokenSage worker died at once, since asking again would crash it again", async () => {
    const { client, batch } = fakeClient();
    const w1 = `${TAG}-w1`;
    batch.mockResolvedValue(
      ok([{ ca: w1, status: "failed", analysis: null, job_id: 9, error: "worker died" }]),
    );
    noteNarrativeWanted(w1, "full", env);
    await flushNarrativeRequests(env, client);
    expect(await prisma.tokenNarrative.findUniqueOrThrow({ where: { mintAddress: w1 } })).toMatchObject({
      status: "failed",
      failReason: "worker died",
    });
  });

  it("caches a dead worker's coded batch error as definitive", async () => {
    const { client, batch } = fakeClient();
    const wd = `${TAG}-wd`;
    const error = "worker_died: worker died; retried automatically after 600 s, or now with refresh=true";
    batch.mockResolvedValue(ok([{ ca: wd, status: "failed", analysis: null, job_id: 9, error }]));
    noteNarrativeWanted(wd, "full", env);
    await flushNarrativeRequests(env, client);
    expect(batch).toHaveBeenCalledTimes(1);
    expect(await prisma.tokenNarrative.findUniqueOrThrow({ where: { mintAddress: wd } })).toMatchObject({
      status: "failed",
      failReason: error,
    });
  });

  it("splits a batch TokenSage refused with 422, so only the offending mint is left out", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-10-07T12:00:00Z"));
      const { client, batch, job } = fakeClient();
      const good = [`${TAG}-v1`, `${TAG}-v2`, `${TAG}-v3`, `${TAG}-v4`];
      const bad = `${TAG}-v-bad`;
      batch.mockImplementation(async (entries: { ca: string }[]) => {
        if (entries.some((e) => e.ca === bad)) throw new HttpError(422, "https://ts.test/v1/tokens:batch");
        return ok(entries.map((e) => ({ ca: e.ca, status: "pending", job_id: 50 })));
      });
      for (const m of [...good, bad]) noteNarrativeWanted(m, "basic", env);
      await flushNarrativeRequests(env, client);
      const accepted = batch.mock.calls.flatMap((c) => cas(c)).filter((m) => m !== bad);
      expect(new Set(accepted)).toEqual(new Set(good));
      expect(job).not.toHaveBeenCalled();

      // The offending mint waits out one window; the others are re-sent as queued reads.
      batch.mockClear();
      batch.mockImplementation(async (entries: { ca: string }[]) =>
        ok(entries.map((e) => ({ ca: e.ca, status: "pending", job_id: 50 }))),
      );
      noteNarrativeWanted(bad, "basic", env);
      await flushNarrativeRequests(env, client);
      const resent = batch.mock.calls.flatMap((c) => cas(c));
      expect(resent).not.toContain(bad);
      expect(new Set(resent)).toEqual(new Set(good));

      vi.setSystemTime(Date.now() + 12 * 60_000);
      noteNarrativeWanted(bad, "basic", env);
      await flushNarrativeRequests(env, client);
      expect(cas(batch.mock.calls.at(-1)!)).toContain(bad);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still finds a queued mint whose failed job got a whole batch refused with 404", async () => {
    const { client, batch, job } = fakeClient();
    const t1 = `${TAG}-t1`;
    const t2 = `${TAG}-t2`;
    batch.mockResolvedValueOnce(
      ok([
        { ca: t1, status: "pending", job_id: 31 },
        { ca: t2, status: "pending", job_id: 32 },
      ]),
    );
    noteNarrativeWanted(t1, "basic", env);
    noteNarrativeWanted(t2, "basic", env);
    await flushNarrativeRequests(env, client);

    // An older TokenSage answers the whole batch 404 while t2's job failed definitively.
    batch.mockImplementation(async (entries: { ca: string }[]) => {
      if (entries.some((e) => e.ca === t2)) throw new HttpError(404, "https://ts.test/v1/tokens:batch");
      return ok(entries.map((e) => ({ ca: e.ca, status: "pending", job_id: 31 })));
    });
    job.mockResolvedValue({
      job_id: 32,
      status: "failed",
      error: "token_not_found: no account found on-chain",
    });
    await flushNarrativeRequests(env, client);
    expect(job.mock.calls.map((c) => c[0])).toEqual([32]);
    // t2 waits out TokenSage's failure window; t1 is re-sent on its own.
    batch.mockClear();
    await flushNarrativeRequests(env, client);
    expect(batch.mock.calls.flatMap((c) => cas(c))).toEqual([t1]);
  });

  it("sends every early deep read, and counts them apart from decision-row reads", async () => {
    const { client, batch } = fakeClient();
    batch.mockImplementation(async (entries: { ca: string }[]) =>
      ok(entries.map((e) => ({ ca: e.ca, status: "pending", job_id: 1 }))),
    );
    const u1 = `${TAG}-u1`;
    const u2 = `${TAG}-u2`;
    const u3 = `${TAG}-u3`;
    noteNarrativeWanted(u1, "full", env, undefined, { early: true });
    noteNarrativeWanted(u2, "full", env, undefined, { early: true });
    // A decision-row read outranks an early note.
    noteNarrativeWanted(u3, "full", env, undefined, { early: true });
    noteNarrativeWanted(u3, "full", env);
    await flushNarrativeRequests(env, client);
    const sent = Object.fromEntries(batch.mock.calls.map((c) => [c[1], cas(c).sort()]));
    expect(sent).toEqual({ full: [u1, u2, u3].sort() });
    expect(takeTokenSageStats()).toMatchObject({ fullToday: 3, earlyFullToday: 2 });
  });

  it("sends the screen-passed quick reads ahead of a backlog of queued first-scan reads", async () => {
    // 2026-10-15: launch reads re-sent every flush filled the quick-read batch, and TokenSage ran
    // them first too, so coins the scan was about to decide on waited behind them.
    const { client, batch } = fakeClient();
    batch.mockImplementation(async (entries: { ca: string }[]) =>
      ok(entries.map((e) => ({ ca: e.ca, status: "pending", job_id: 1 }))),
    );
    const on = { ...env, TOKENSAGE_MAX_BATCHES_PER_CYCLE: 1 };
    const now = Date.now();
    const launches = Array.from({ length: TOKENSAGE_PREFETCH_CHUNK }, (_, i) => ({
      mintAddress: `${TAG}-tier-launch${i}`,
      createdAt: new Date(now - 1_000),
    }));
    for (const l of launches) noteNarrativeWanted(l.mintAddress, "basic", on, undefined, { firstScan: true });
    await flushNarrativeRequests(on, client);
    expect(new Set((batch.mock.calls[0]![0] as { priority: string }[]).map((e) => e.priority))).toEqual(
      new Set(["low"]),
    );

    // A watchlist read goes first, and a launch read the scan now wants is raised to its tier.
    const watch = `${TAG}-tier-watch`;
    const raised = launches[5]!.mintAddress;
    noteNarrativeWanted(watch, "basic", on);
    noteNarrativeWanted(raised, "basic", on);
    await flushNarrativeRequests(on, client);
    const second = batch.mock.calls[1]![0] as { ca: string; priority: string }[];
    expect(second.slice(0, 2)).toMatchObject([
      { ca: raised, priority: "normal" },
      { ca: watch, priority: "normal" },
    ]);
    expect(second.slice(2).every((e) => e.priority === "low")).toBe(true);

    // A deep read is normal too, and a later launch note never lowers the watchlist's tier.
    noteNarrativeWanted(watch, "full", on);
    noteNarrativeWanted(`${TAG}-tier-x`, "basic", on, undefined, { firstScan: true });
    noteNarrativeWanted(`${TAG}-tier-x`, "basic", on);
    noteNarrativeWanted(`${TAG}-tier-x`, "basic", on, undefined, { firstScan: true });
    await flushNarrativeRequests({ ...on, TOKENSAGE_MAX_BATCHES_PER_CYCLE: 2 }, client);
    expect(batch.mock.calls[2]![1]).toBe("full");
    expect(batch.mock.calls[2]![0]).toEqual([{ ca: watch, priority: "normal" }]);
    const fourth = batch.mock.calls[3]![0] as { ca: string; priority: string }[];
    expect(fourth.find((e) => e.ca === `${TAG}-tier-x`)?.priority).toBe("normal");
    expect(fourth.map((e) => e.priority).slice(0, 3)).toEqual(["normal", "normal", "normal"]);
  });

  it("asks for new mints while a backlog of queued ones fills the batches, and re-sends that backlog in turn", async () => {
    const { client, batch } = fakeClient();
    batch.mockImplementation(async (entries: { ca: string }[]) =>
      ok(entries.map((e) => ({ ca: e.ca, status: "pending", job_id: 1 }))),
    );
    const two = { ...env, TOKENSAGE_MAX_BATCHES_PER_CYCLE: 2 };
    const backlog = Array.from({ length: 3 * TOKENSAGE_PREFETCH_CHUNK }, (_, i) => `${TAG}-q${i}`);
    for (const m of backlog) noteNarrativeWanted(m, "basic", two);
    await flushNarrativeRequests(two, client);
    await flushNarrativeRequests(two, client);
    // All three chunks queued at TokenSage, more than one flush's two batches.
    expect(takeTokenSageStats()).toMatchObject({ pending: backlog.length, waiting: 0 });

    batch.mockClear();
    const late = `${TAG}-q-late`;
    noteNarrativeWanted(late, "basic", two);
    await flushNarrativeRequests(two, client);
    expect(batch.mock.calls.flatMap(cas)).toContain(late);

    // Every queued mint is re-sent within a few flushes, not only the first two chunks.
    for (let i = 0; i < 3; i += 1) await flushNarrativeRequests(two, client);
    const resent = new Set(batch.mock.calls.flatMap(cas));
    expect(backlog.filter((m) => !resent.has(m))).toEqual([]);
  });

  it("keeps a full read queued when the mint's basic read lands in the same flush, and counts it", async () => {
    const { client, batch } = fakeClient();
    const w = `${TAG}-w`;
    batch.mockResolvedValueOnce(ok([{ ca: w, status: "pending", job_id: 1 }]));
    noteNarrativeWanted(w, "basic", env);
    await flushNarrativeRequests(env, client);

    // The decision row asks for full; the basic job finishes before that flush.
    batch.mockImplementation(async (entries: { ca: string }[], depth: string) =>
      depth === "full"
        ? ok([{ ca: w, status: "pending", job_id: 2 }])
        : ok(entries.map((e) => ({ ca: e.ca, status: "complete", analysis: analysis(e.ca, "basic") }))),
    );
    noteNarrativeWanted(w, "full", env);
    await flushNarrativeRequests(env, client);
    expect(batch.mock.calls.map((c) => c[1])).toEqual(["basic", "full", "basic"]);
    expect(takeTokenSageStats()).toMatchObject({ pending: 1, requested: 2, fullToday: 1 });

    batch.mockResolvedValueOnce(ok([{ ca: w, status: "complete", analysis: analysis(w, "full") }]));
    await flushNarrativeRequests(env, client);
    expect(batch.mock.calls.at(-1)![1]).toBe("full");
    const row = await prisma.tokenNarrative.findUniqueOrThrow({ where: { mintAddress: w } });
    expect(row.depth).toBe("full");
  });

  it("keeps tracking the full job when the basic re-send in the same flush is still queued", async () => {
    const { client, batch, job } = fakeClient();
    const w = `${TAG}-w2`;
    batch.mockResolvedValueOnce(ok([{ ca: w, status: "pending", job_id: 1 }]));
    noteNarrativeWanted(w, "basic", env);
    await flushNarrativeRequests(env, client);

    batch.mockImplementation(async (_entries: { ca: string }[], depth: string) =>
      ok([{ ca: w, status: "pending", job_id: depth === "full" ? 2 : 1 }]),
    );
    noteNarrativeWanted(w, "full", env);
    await flushNarrativeRequests(env, client);
    expect(batch.mock.calls.map((c) => c[1])).toEqual(["basic", "full", "basic"]);
    // Neither job is taken for ended: the full one is still running, and the basic one isn't queued.
    expect(job).not.toHaveBeenCalled();
    await flushNarrativeRequests(env, client);
    expect(batch.mock.calls.at(-1)![1]).toBe("full");
    expect(job).not.toHaveBeenCalled();
  });

  it("sends the youngest coins first, and keeps a batch for quick reads behind a deep backlog", async () => {
    const { client, batch } = fakeClient();
    batch.mockImplementation(async (entries: { ca: string }[]) =>
      ok(entries.map((e) => ({ ca: e.ca, status: "pending", job_id: 1 }))),
    );
    const two = { ...env, TOKENSAGE_MAX_BATCHES_PER_CYCLE: 2 };
    const now = Date.now();
    const launched = (minutesAgo: number) => ({
      created_at: new Date(now - minutesAgo * 60_000).toISOString(),
    });
    const deep = Array.from({ length: 2 * TOKENSAGE_PREFETCH_CHUNK }, (_, i) => `${TAG}-deep${i}`);
    for (const m of deep) noteNarrativeWanted(m, "full", two, launched(5));
    const old = Array.from({ length: TOKENSAGE_PREFETCH_CHUNK }, (_, i) => `${TAG}-old${i}`);
    for (const m of old) noteNarrativeWanted(m, "basic", two, launched(8));
    const undated = `${TAG}-undated`;
    noteNarrativeWanted(undated, "basic", two);
    const fresh = `${TAG}-fresh`;
    noteNarrativeWanted(fresh, "basic", two, launched(0.2));
    await flushNarrativeRequests(two, client);
    expect(batch.mock.calls.map((c) => c[1])).toEqual(["full", "basic"]);
    const basic = cas(batch.mock.calls[1]!);
    expect(basic[0]).toBe(fresh);
    expect(basic).not.toContain(undated);
  });

  it("drops a basic read nobody has asked for again in ten minutes, but not a deep one", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { client, batch } = fakeClient();
      batch.mockRejectedValueOnce(new HttpError(429, "https://ts.test/v1/tokens:batch"));
      const stale = `${TAG}-stale`;
      const deep = `${TAG}-stale-full`;
      const kept = `${TAG}-stale-kept`;
      noteNarrativeWanted(stale, "basic", env);
      noteNarrativeWanted(deep, "full", env);
      noteNarrativeWanted(kept, "basic", env);
      await flushNarrativeRequests(env, client);

      vi.setSystemTime(Date.now() + 9 * 60_000);
      noteNarrativeWanted(kept, "basic", env);
      vi.setSystemTime(Date.now() + 2 * 60_000);
      batch.mockResolvedValue(ok([]));
      await flushNarrativeRequests(env, client);
      expect(Object.fromEntries(batch.mock.calls.slice(1).map((c) => [c[1], cas(c)]))).toEqual({
        full: [deep],
        basic: [kept],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-sends queued requests between scans when polling is on", async () => {
    const { client, batch } = fakeClient();
    expect(startNarrativePolling({ ...env, TOKENSAGE_POLL_SECONDS: 0 }, client)).toBeUndefined();
    const v = `${TAG}-v`;
    batch.mockResolvedValueOnce(ok([{ ca: v, status: "pending", job_id: 41 }]));
    noteNarrativeWanted(v, "basic", env);
    await flushNarrativeRequests(env, client);
    batch.mockResolvedValueOnce(ok([{ ca: v, status: "complete", analysis: analysis(v, "basic") }]));
    const stop = startNarrativePolling({ ...env, TOKENSAGE_POLL_SECONDS: 0.05 }, client)!;
    try {
      await vi.waitFor(async () => {
        expect(await prisma.tokenNarrative.count({ where: { mintAddress: v } })).toBe(1);
      });
    } finally {
      stop();
    }
    expect(cas(batch.mock.calls[1]!)).toEqual([v]);
  });
});
