// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { readFileSync } from "node:fs";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, loadEnv, HttpError, type Env, type TokenSageClient } from "@trenchscanner/core";
import {
  flushNarrativeRequests,
  noteNarrativeWanted,
  resetTokenSage,
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
    expect(batch.mock.calls[0]![0]).toEqual([{ ca: a, hints: { name: "Dog", symbol: "DOG" } }, { ca: b }]);
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
    expect(takeTokenSageStats()).toMatchObject({ stored: 1, turnedAway: 1 });

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

  it("keeps full-depth requests under our own daily cap", async () => {
    const { client, batch } = fakeClient();
    batch.mockResolvedValue(ok([]));
    const capped = { ...env, TOKENSAGE_FULL_PER_DAY: 1 };
    noteNarrativeWanted(`${TAG}-h1`, "full", capped);
    noteNarrativeWanted(`${TAG}-h2`, "full", capped);
    await flushNarrativeRequests(capped, client);
    const fullCalls = batch.mock.calls.filter((c) => c[1] === "full");
    expect(fullCalls.map(cas)).toEqual([[`${TAG}-h1`]]);
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
});
