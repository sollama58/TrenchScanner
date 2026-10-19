// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, loadEnv, TradeRejected, TransientError, type Env } from "@trenchscanner/core";
import { JobFailure } from "../scheduler.js";
import {
  canaryFailureMeta,
  pickCanaryMints,
  runCanaryProbes,
  runTradeCanary,
  USDC_MINT,
  type CanaryClients,
} from "./tradeCanaryJob.js";

const MIN = 60_000;
const GRAD = "Grad1111111111111111111111111111111111pump";
const CURVE_A = "CurveA11111111111111111111111111111111pump";
const CURVE_B = "CurveB11111111111111111111111111111111pump";

/** Every dependency answering, unless a test says otherwise. */
const clients = (over: Partial<CanaryClients> = {}): CanaryClients => ({
  build: vi.fn().mockResolvedValue({ transaction: "x" }),
  senderPing: vi.fn().mockResolvedValue(undefined),
  blockHeight: vi.fn().mockResolvedValue(300_000_000),
  backupBlockHeight: vi.fn().mockResolvedValue(300_000_001),
  ...over,
});

describe("trade canary: the probes", () => {
  it("builds on SOL->USDC, a graduated coin and a curve coin, and checks Sender and both RPCs", async () => {
    const c = clients();
    const probes = await runCanaryProbes(c, { graduated: [GRAD], curve: [CURVE_A] });
    expect(probes.map((p) => [p.key, p.status])).toEqual([
      ["sol-usdc", "ok"],
      ["graduated", "ok"],
      ["curve", "ok"],
      ["sender", "ok"],
      ["rpc", "ok"],
      ["backup-rpc", "ok"],
    ]);
    expect(vi.mocked(c.build).mock.calls.map((a) => a[0])).toEqual([USDC_MINT, GRAD, CURVE_A]);
  });

  it("tries the next coin when one is refused as a coin, and fails when every one is", async () => {
    const build = vi.fn(async (mint: string) => {
      if (mint === CURVE_A) throw new TradeRejected("no route for this token (curve complete)");
      return {};
    });
    const ok = await runCanaryProbes(clients({ build }), { graduated: [GRAD], curve: [CURVE_A, CURVE_B] });
    expect(ok.find((p) => p.key === "curve")).toMatchObject({ status: "ok", detail: CURVE_B });

    const all = vi.fn(async (mint: string) => {
      if (mint !== USDC_MINT) throw new TradeRejected("no route");
      return {};
    });
    const bad = await runCanaryProbes(clients({ build: all }), { graduated: [GRAD], curve: [CURVE_A] });
    expect(bad.find((p) => p.key === "curve")?.status).toBe("failed");
    expect(bad.find((p) => p.key === "graduated")?.status).toBe("failed");
  });

  it("fails a build at once on a chain or Jupiter failure, without trying more coins", async () => {
    const build = vi.fn(async (mint: string) => {
      if (mint === CURVE_A) throw new TransientError("couldn't read a recent blockhash");
      return {};
    });
    const probes = await runCanaryProbes(clients({ build }), {
      graduated: [GRAD],
      curve: [CURVE_A, CURVE_B],
    });
    expect(probes.find((p) => p.key === "curve")).toMatchObject({ status: "failed" });
    expect(build).not.toHaveBeenCalledWith(CURVE_B);
  });

  it("cuts a probe that doesn't answer off at its timeout", async () => {
    const senderPing = vi.fn(() => new Promise<void>(() => undefined));
    const probes = await runCanaryProbes(clients({ senderPing }), { graduated: [], curve: [] }, 50);
    expect(probes.find((p) => p.key === "sender")).toMatchObject({
      status: "failed",
      detail: "no answer in 0s",
    });
  });

  it("skips what it has nothing to probe with, and fails a dead RPC", async () => {
    const probes = await runCanaryProbes(
      clients({ blockHeight: vi.fn().mockResolvedValue(null), backupBlockHeight: null }),
      { graduated: [], curve: [] },
    );
    const by = Object.fromEntries(probes.map((p) => [p.key, p.status]));
    expect(by).toMatchObject({
      graduated: "skipped",
      curve: "skipped",
      "backup-rpc": "skipped",
      rpc: "failed",
    });
  });
});

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

describe.skipIf(!dbAvailable)("trade canary against the database", () => {
  const env: Env = dbAvailable ? { ...loadEnv(), TRADE_CANARY_PUMP_MINT: "" } : (undefined as never);
  const TAG = `tc${Date.now()}`;

  beforeEach(async () => {
    await prisma.systemHeartbeat.deleteMany({ where: { job: "trade-canary" } });
  });
  afterAll(async () => {
    if (!dbAvailable) return;
    await prisma.systemHeartbeat.deleteMany({ where: { job: "trade-canary" } });
    await prisma.token.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
  });

  /** The scheduler's write of a run's result, as it records it. */
  const record = async (run: Promise<unknown>) => {
    const out = await run.then(
      (meta) => ({ ok: true as const, meta }),
      (err: unknown) => ({ ok: false as const, err }),
    );
    const meta = (out.ok ? out.meta : (out.err as JobFailure).meta) as object;
    await prisma.systemHeartbeat.upsert({
      where: { job: "trade-canary" },
      create: { job: "trade-canary", lastRunAt: new Date(), meta },
      update: { lastRunAt: new Date(), meta },
    });
    return out;
  };

  it("counts failed runs in a row on its heartbeat, and starts again at zero once a run passes", async () => {
    const mints = { graduated: [GRAD], curve: [CURVE_A] };
    const down = clients({ senderPing: vi.fn().mockRejectedValue(new Error("Sender /ping answered 503")) });
    const first = await record(runTradeCanary(env, { clients: down, mints }));
    expect(first.ok).toBe(false);
    expect((first as { err: JobFailure }).err).toBeInstanceOf(JobFailure);
    expect((first as { err: JobFailure }).err.message).toContain("sender: Sender /ping answered 503");
    expect((first as { err: JobFailure }).err.meta).toMatchObject({
      consecutiveFailures: 1,
      probes: { sender: "failed", "sol-usdc": "ok" },
    });

    const second = await record(runTradeCanary(env, { clients: down, mints }));
    expect((second as { err: JobFailure }).err.meta.consecutiveFailures).toBe(2);
    // A run given up at its deadline still counts on.
    expect(canaryFailureMeta()).toEqual({ consecutiveFailures: 3 });

    const healed = await record(runTradeCanary(env, { clients: clients(), mints }));
    expect(healed.ok).toBe(true);
    expect((healed as { meta: Record<string, unknown> }).meta).toMatchObject({
      consecutiveFailures: 0,
      failed: 0,
      graduatedMint: GRAD,
      curveMint: CURVE_A,
    });
  });

  it("picks a liquid graduated coin and a live curve coin from recent tokens", async () => {
    const now = Date.now();
    const live = new Date(now - MIN);
    await prisma.token.createMany({
      data: [
        // Graduated and deep, but its mint is not a Pump.fun one.
        {
          mintAddress: `${TAG}bigX`,
          firstInBandAt: new Date(now - 60 * MIN),
          lastLiveAt: live,
          lastMcapUsd: 9e6,
        },
        {
          mintAddress: `${TAG}bigpump`,
          firstInBandAt: new Date(now - 60 * MIN),
          lastLiveAt: live,
          lastMcapUsd: 2e6,
        },
        // Big, but no reading for an hour.
        {
          mintAddress: `${TAG}stalepump`,
          firstInBandAt: new Date(now - 60 * MIN),
          lastLiveAt: new Date(now - 60 * MIN),
          lastMcapUsd: 5e6,
        },
        {
          mintAddress: `${TAG}curvepump`,
          firstSeenAt: new Date(now - 20 * MIN),
          lastLiveAt: live,
          lastMcapUsd: 9_000,
        },
        // A Mayhem coin the scan stopped watching.
        {
          mintAddress: `${TAG}mayhempump`,
          firstSeenAt: new Date(now - 20 * MIN),
          lastLiveAt: live,
          lastMcapUsd: 9_000,
          ignoredAt: new Date(now - 10 * MIN),
        },
      ],
    });
    const mints = await pickCanaryMints({ TRADE_CANARY_PUMP_MINT: GRAD }, now);
    expect(mints.graduated).toContain(`${TAG}bigpump`);
    expect(mints.graduated).not.toContain(`${TAG}bigX`);
    expect(mints.graduated).not.toContain(`${TAG}stalepump`);
    // The configured coin comes after the ones the scan saw.
    expect(mints.graduated.indexOf(GRAD)).toBeGreaterThan(mints.graduated.indexOf(`${TAG}bigpump`));
    expect(mints.curve).toContain(`${TAG}curvepump`);
    expect(mints.curve).not.toContain(`${TAG}mayhempump`);
  });
});
