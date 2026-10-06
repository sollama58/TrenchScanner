// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
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

const analysis = (mint: string, depth: "basic" | "full") => ({
  mint,
  depth,
  analyzed_at: new Date().toISOString(),
  categories: [{ label: "animal/dog", confidence: 0.8 }],
  flags: [{ code: "copycat", severity: "warn" }],
  summary: "A dog coin",
  versions: { rules: "1" },
});

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

  it("stores cached answers, polls queued jobs, and never asks twice", async () => {
    const { client, batch, job } = fakeClient();
    const a = `${TAG}-a`;
    const b = `${TAG}-b`;
    batch.mockResolvedValueOnce([
      { ca: a, status: "complete", analysis: analysis(a, "basic") },
      { ca: b, status: "pending", job_id: 7 },
    ]);
    noteNarrativeWanted(a, "basic", env);
    noteNarrativeWanted(b, "basic", env);
    await flushNarrativeRequests(env, client);
    expect(batch).toHaveBeenCalledWith([a, b], "basic");
    const rowA = await prisma.tokenNarrative.findUniqueOrThrow({ where: { mintAddress: a } });
    expect(rowA).toMatchObject({
      depth: "basic",
      status: "complete",
      flags: ["copycat"],
      summary: "A dog coin",
    });

    // Next cycle: both are noted again; a is settled, b is queued - only the poll goes out.
    job.mockResolvedValueOnce({ job_id: 7, status: "done", result: { analysis: analysis(b, "basic") } });
    noteNarrativeWanted(a, "basic", env);
    noteNarrativeWanted(b, "basic", env);
    await flushNarrativeRequests(env, client);
    expect(batch).toHaveBeenCalledTimes(1);
    expect(job).toHaveBeenCalledWith(7);
    expect(await prisma.tokenNarrative.count({ where: { mintAddress: b } })).toBe(1);
    expect(takeTokenSageStats()).toMatchObject({ requested: 2, stored: 2, pending: 0 });
  });

  it("upgrades to full depth and never lets a basic answer overwrite it", async () => {
    const { client, batch } = fakeClient();
    const c = `${TAG}-c`;
    batch.mockResolvedValueOnce([{ ca: c, status: "complete", analysis: analysis(c, "full") }]);
    noteNarrativeWanted(c, "basic", env);
    noteNarrativeWanted(c, "full", env);
    await flushNarrativeRequests(env, client);
    expect(batch).toHaveBeenCalledWith([c], "full");

    batch.mockResolvedValueOnce([{ ca: c, status: "complete", analysis: analysis(c, "basic") }]);
    resetTokenSage();
    noteNarrativeWanted(c, "basic", env);
    await flushNarrativeRequests(env, client);
    // Already stored at full depth: not even sent.
    expect(batch).toHaveBeenCalledTimes(1);
    expect((await prisma.tokenNarrative.findUniqueOrThrow({ where: { mintAddress: c } })).depth).toBe("full");
  });

  it("caches definitive failures and pauses after a 429", async () => {
    const { client, batch } = fakeClient();
    const d = `${TAG}-d`;
    batch.mockRejectedValueOnce(new HttpError(429, "https://ts.test/v1/tokens:batch"));
    noteNarrativeWanted(d, "basic", env);
    await flushNarrativeRequests(env, client);
    await flushNarrativeRequests(env, client);
    expect(batch).toHaveBeenCalledTimes(1);

    resetTokenSage();
    batch.mockResolvedValueOnce([{ ca: d, status: "invalid", error: "not a mint" }]);
    noteNarrativeWanted(d, "basic", env);
    await flushNarrativeRequests(env, client);
    expect((await prisma.tokenNarrative.findUniqueOrThrow({ where: { mintAddress: d } })).status).toBe(
      "failed",
    );
  });

  it("keeps full-depth requests under the daily cap", async () => {
    const { client, batch } = fakeClient();
    batch.mockResolvedValue([]);
    const capped = { ...env, TOKENSAGE_FULL_PER_DAY: 1 };
    noteNarrativeWanted(`${TAG}-e1`, "full", capped);
    noteNarrativeWanted(`${TAG}-e2`, "full", capped);
    await flushNarrativeRequests(capped, client);
    expect(batch).toHaveBeenCalledWith([`${TAG}-e1`], "full");
    await flushNarrativeRequests(capped, client);
    expect(batch).toHaveBeenCalledTimes(1);
  });
});
