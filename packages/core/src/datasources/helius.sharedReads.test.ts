import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  activityStretch,
  HeliusClient,
  type EarliestActivityResult,
  type WalletSignaturesPage,
} from "./helius.js";

/**
 * One signatures page per wallet shared by the freshness and funder reads, and reads in flight
 * shared between calls (Helius audit 2026-10-23, N-1 and N-3). Against a local server that answers
 * as the RPC does: newest first, cut to the `limit` asked.
 */

let server: Server | undefined;

type Call = { id: string; method: string; params: unknown[] };

async function startServer(
  handler: (call: Call) => unknown,
  delayMs = 0,
): Promise<{ url: string; calls: Call[] }> {
  const calls: Call[] = [];
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = JSON.parse(raw) as Call[];
      calls.push(...body);
      res.setHeader("content-type", "application/json");
      const reply = body.map((c) => ({ jsonrpc: "2.0", id: c.id, ...(handler(c) as object) }));
      setTimeout(() => res.end(JSON.stringify(reply)), delayMs);
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("failed to bind test server");
  return { url: `http://127.0.0.1:${address.port}`, calls };
}

afterEach(async () => {
  vi.restoreAllMocks();
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

const SECONDS = 1_700_000_000;
const NOW_S = SECONDS + 400 * 86_400;
const SOL = 1_000_000_000;
const ERR = { InstructionError: [0, "x"] };

/** A plain transfer of 1 SOL from `funder` into `wallet`. */
function funding(wallet: string, funder: string, blockTime: number) {
  return {
    blockTime,
    meta: { err: null, preBalances: [3 * SOL, 0], postBalances: [2 * SOL - 5000, 1 * SOL] },
    transaction: { message: { accountKeys: [funder, wallet], header: { numRequiredSignatures: 1 } } },
  };
}

/** Recorded pages, newest first, and the transactions behind them. */
function recorded() {
  const pages: Record<string, WalletSignaturesPage | "error"> = {};
  const txs: Record<string, unknown> = {};
  const run = (wallet: string, n: number, time: (i: number) => number | null, err?: (i: number) => boolean) =>
    Array.from({ length: n }, (_, i) => ({
      signature: `${wallet}-${i}`,
      blockTime: time(i),
      ...(err?.(i) ? { err: ERR } : {}),
    }));
  // A short history with a failed transaction at its start.
  pages.fresh = [
    { signature: "fresh-2", blockTime: NOW_S - 60 },
    { signature: "fresh-1", blockTime: NOW_S - 120 },
    { signature: "fresh-0", blockTime: NOW_S - 180, err: ERR },
  ];
  txs["fresh-1"] = funding("fresh", "F1", NOW_S - 120);
  // Idle for a year, paid again an hour ago: a gap inside a partial page.
  pages.revived = [
    ...run("revived-new", 20, (i) => NOW_S - 60 - i * 60),
    ...run("revived-old", 130, (i) => SECONDS - i * 60),
  ];
  txs["revived-new-19"] = funding("revived", "R1", NOW_S - 60 - 19 * 60);
  // 450 rows: a full 200 page, a partial 1000 one; every seventh failed.
  pages.mid = run(
    "mid",
    450,
    (i) => NOW_S - 100 - i * 30,
    (i) => i % 7 === 3,
  );
  txs["mid-449"] = funding("mid", "M1", NOW_S - 100 - 449 * 30);
  // Exactly 200 rows: full for freshness, the whole history for funders.
  pages.exact200 = run("exact200", 200, (i) => NOW_S - 100 - i * 30);
  txs["exact200-199"] = funding("exact200", "E1", NOW_S - 100 - 199 * 30);
  // Busy: more than one 1000 page, so the funder read answers "busy" off Helius.
  pages.busy = run("busy", 1500, (i) => NOW_S - 10 - i);
  // The oldest row has no block time.
  pages.untimed = run("untimed", 5, (i) => (i === 4 ? null : NOW_S - 100 - i));
  pages.empty = [];
  pages.broken = "error";
  return { pages, txs };
}

function rpcHandler({ pages, txs }: ReturnType<typeof recorded>) {
  return (c: Call) => {
    if (c.method === "getSignaturesForAddress") {
      const page = pages[c.params[0] as string];
      if (page === "error") return { error: { code: -32000, message: "boom" } };
      return { result: (page ?? []).slice(0, (c.params[1] as { limit: number }).limit) };
    }
    if (c.method === "getTransaction") return { result: txs[c.params[0] as string] ?? null };
    return { error: { code: -32601, message: "method not found" } };
  };
}

/**
 * The freshness answer as the code before the shared page gave it, copied from it: its own
 * request for the newest 200 signatures, read the same way.
 */
function earliestFromPage200(res: { result?: WalletSignaturesPage; error?: unknown } | undefined) {
  const SIGNATURES_PAGE_LIMIT = 200;
  if (!res || res.error) return { status: "failed" } as EarliestActivityResult;
  const sigs = res.result;
  if (!sigs || sigs.length === 0) return { status: "indeterminate" } as EarliestActivityResult;
  const oldest = sigs[sigs.length - 1];
  if (!oldest?.blockTime) return { status: "indeterminate" } as EarliestActivityResult;
  const oldestAt = new Date(oldest.blockTime * 1000);
  const times = sigs.map((s) => s.blockTime).filter((t): t is number => typeof t === "number");
  const stretch = activityStretch(times);
  return (
    sigs.length >= SIGNATURES_PAGE_LIMIT
      ? { status: "older-than", boundAt: oldestAt, ...stretch }
      : {
          status: "found",
          earliestActivityAt: oldestAt,
          activeSince: stretch.activeSince ?? oldestAt,
          lastActivityAt: stretch.lastActivityAt,
        }
  ) as EarliestActivityResult;
}

const WALLETS = ["fresh", "revived", "mid", "exact200", "busy", "untimed", "empty", "broken"];

describe("one signatures page for freshness and funders (golden)", () => {
  it("gives the answers each read gave on its own, for one page per wallet", async () => {
    const data = recorded();
    const handler = rpcHandler(data);
    const { url, calls } = await startServer(handler);

    // Before: freshness read its own 200 page, funders their own 1000 page.
    const before = new Map(
      WALLETS.map((w) => [
        w,
        earliestFromPage200(
          handler({ id: w, method: "getSignaturesForAddress", params: [w, { limit: 200 }] }) as {
            result?: WalletSignaturesPage;
          },
        ),
      ]),
    );
    const alone = new HeliusClient({ rpcUrl: url });
    const fundersBefore = await alone.getFundersBatch(WALLETS, { nowMs: NOW_S * 1000 });
    calls.length = 0;

    // Now: both on one client, side by side as the cycle runs them.
    const client = new HeliusClient({ rpcUrl: url });
    const [freshness, funders] = await Promise.all([
      client.getEarliestActivityBatch(WALLETS),
      client.getFundersBatch(WALLETS, { nowMs: NOW_S * 1000 }),
    ]);
    expect(freshness).toEqual(before);
    expect(funders).toEqual(fundersBefore);
    // Spot checks that the fixtures reach every case.
    expect(freshness.get("mid")).toMatchObject({ status: "older-than" });
    expect(freshness.get("exact200")).toMatchObject({ status: "older-than" });
    expect(freshness.get("revived")).toMatchObject({ status: "found" });
    expect(freshness.get("untimed")).toEqual({ status: "indeterminate" });
    expect(freshness.get("broken")).toEqual({ status: "failed" });
    expect(funders.get("fresh")).toMatchObject({ status: "found", funder: "F1" });
    expect(funders.get("revived")).toMatchObject({ status: "found", funder: "R1", revived: true });
    expect(funders.get("mid")).toMatchObject({ status: "found", funder: "M1" });
    expect(funders.get("exact200")).toMatchObject({ status: "found", funder: "E1" });
    expect(funders.get("busy")).toEqual({ status: "busy", lastActivityAt: new Date((NOW_S - 10) * 1000) });
    expect(funders.get("empty")).toEqual({ status: "empty" });
    expect(funders.get("broken")).toEqual({ status: "failed" });

    // One page per wallet, the broken one included (a failed read is not kept, but it was shared).
    const pages = calls.filter((c) => c.method === "getSignaturesForAddress").map((c) => c.params[0]);
    expect(pages.sort()).toEqual([...WALLETS].sort());
  });

  it("answers the same whichever read comes first", async () => {
    const data = recorded();
    const { url } = await startServer(rpcHandler(data));
    const reference = new HeliusClient({ rpcUrl: url });
    const freshnessAlone = await reference.getEarliestActivityBatch(WALLETS);
    const fundersAlone = await new HeliusClient({ rpcUrl: url }).getFundersBatch(WALLETS, {
      nowMs: NOW_S * 1000,
    });

    const fundersFirst = new HeliusClient({ rpcUrl: url });
    const funders = await fundersFirst.getFundersBatch(WALLETS, { nowMs: NOW_S * 1000 });
    expect(await fundersFirst.getEarliestActivityBatch(WALLETS)).toEqual(freshnessAlone);
    expect(funders).toEqual(fundersAlone);

    const freshnessFirst = new HeliusClient({ rpcUrl: url });
    expect(await freshnessFirst.getEarliestActivityBatch(WALLETS)).toEqual(freshnessAlone);
    expect(await freshnessFirst.getFundersBatch(WALLETS, { nowMs: NOW_S * 1000 })).toEqual(fundersAlone);
  });
});

describe("shared reads: calls sent", () => {
  it("reads a wallet's page once for freshness, funders and the hot-funder check", async () => {
    const data = recorded();
    const { url, calls } = await startServer(rpcHandler(data), 20);
    const client = new HeliusClient({ rpcUrl: url });
    await Promise.all([
      client.getEarliestActivityBatch(["fresh", "mid"]),
      client.getFundersBatch(["fresh", "mid", "exact200"], { nowMs: NOW_S * 1000 }),
      client.getFunderActivityBatch(["mid", "exact200"]),
    ]);
    await client.getEarliestActivityBatch(["exact200"]);
    const pages = calls.filter((c) => c.method === "getSignaturesForAddress").map((c) => c.params[0]);
    expect(pages.sort()).toEqual(["exact200", "fresh", "mid"]);
    expect(client.takeCallStats().getSignaturesForAddress).toBe(3);
  });

  it("reads a page again once SIGNATURES_PAGE_REUSE_MS has passed", async () => {
    const data = recorded();
    const { url, calls } = await startServer(rpcHandler(data));
    const client = new HeliusClient({ rpcUrl: url });
    let now = NOW_S * 1000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    await client.getEarliestActivityBatch(["fresh"]);
    now += 29_000;
    await client.getFundersBatch(["fresh"], { nowMs: now });
    expect(calls.filter((c) => c.method === "getSignaturesForAddress")).toHaveLength(1);
    now += 2_000;
    await client.getEarliestActivityBatch(["fresh"]);
    expect(calls.filter((c) => c.method === "getSignaturesForAddress")).toHaveLength(2);
  });

  it("doesn't keep a failed page", async () => {
    const data = recorded();
    const { url, calls } = await startServer(rpcHandler(data));
    const client = new HeliusClient({ rpcUrl: url });
    expect((await client.getEarliestActivityBatch(["broken"])).get("broken")).toEqual({ status: "failed" });
    expect((await client.getFundersBatch(["broken"])).get("broken")).toEqual({ status: "failed" });
    expect(calls.filter((c) => c.method === "getSignaturesForAddress")).toHaveLength(2);
  });

  it("walks a wallet's first transactions once when two calls read its funder at once", async () => {
    const data = recorded();
    const { url, calls } = await startServer(rpcHandler(data), 20);
    const client = new HeliusClient({ rpcUrl: url });
    const [a, b] = await Promise.all([
      client.getFundersBatch(["fresh", "mid"], { nowMs: NOW_S * 1000 }),
      client.getFundersBatch(["fresh"], { nowMs: NOW_S * 1000 }),
    ]);
    expect(b.get("fresh")).toEqual(a.get("fresh"));
    expect(calls.filter((c) => c.method === "getTransaction" && c.params[0] === "fresh-1")).toHaveLength(1);
  });

  it("reads alone a wallet handed in with a different stored funder", async () => {
    const data = recorded();
    const { url, calls } = await startServer(rpcHandler(data), 20);
    const client = new HeliusClient({ rpcUrl: url });
    const known = new Map([["mid", { funder: "K", amountSol: 1, fundedAt: null }]]);
    const [plain, withKnown] = await Promise.all([
      client.getFundersBatch(["mid"], { nowMs: NOW_S * 1000 }),
      client.getFundersBatch(["mid"], { nowMs: NOW_S * 1000, knownOf: known }),
    ]);
    expect(plain.get("mid")).toMatchObject({ status: "found", funder: "M1" });
    expect(withKnown.get("mid")).toMatchObject({ status: "found", funder: "K", reads: 0 });
    // The page is still one read.
    expect(calls.filter((c) => c.method === "getSignaturesForAddress")).toHaveLength(1);
  });
});

describe("shared reads on Helius: sorted lookups", () => {
  const cutoff = NOW_S - 86_400;

  function heliusHandler() {
    const data = recorded();
    const base = rpcHandler(data);
    return (c: Call) => {
      if (c.method !== "getTransactionsForAddress") return base(c);
      const [address, config] = c.params as [string, { transactionDetails: string }];
      if (config.transactionDetails === "signatures")
        return { result: { data: [{ signature: `${address}-first`, blockTime: SECONDS }] } };
      // A launch read or a busy wallet's first transactions.
      return { result: { data: address === "busy" ? [funding("busy", "B1", SECONDS)] : [] } };
    };
  }

  it("sends one sorted lookup per busy wallet when a fast scan and the cycle ask at once", async () => {
    const { url, calls } = await startServer(heliusHandler(), 20);
    const client = new HeliusClient({ rpcUrl: `${url}/?helius=1` });
    const opts = { boundSufficientBefore: new Date(cutoff * 1000) };
    const [cycle, fast] = await Promise.all([
      client.getEarliestActivityBatch(["busy", "fresh"], opts),
      client.getEarliestActivityBatch(["busy"], { boundSufficientBefore: new Date(cutoff * 1000 + 5) }),
      client.getFundersBatch(["busy"], { nowMs: NOW_S * 1000 }),
      client.getFundersBatch(["busy"], { nowMs: NOW_S * 1000 }),
    ]);
    expect(cycle.get("busy")).toEqual({
      status: "found",
      earliestActivityAt: new Date(SECONDS * 1000),
      lastActivityAt: new Date((NOW_S - 10) * 1000),
    });
    expect(fast.get("busy")).toEqual(cycle.get("busy"));
    const sorted = calls.filter((c) => c.method === "getTransactionsForAddress");
    // One signatures-only lookup for the earliest activity, one full one for the funder: they
    // ask different things (the funder lookup skips failed transactions) and are not shared.
    expect(
      sorted.map((c) => (c.params[1] as { transactionDetails: string }).transactionDetails).sort(),
    ).toEqual(["full", "signatures"]);
    expect(calls.filter((c) => c.method === "getSignaturesForAddress")).toHaveLength(2);
  });

  it("reads a launch once when a fast scan and the cycle ask for it at once", async () => {
    const { url, calls } = await startServer(heliusHandler(), 20);
    const client = new HeliusClient({ rpcUrl: `${url}/?helius=1` });
    const [a, b] = await Promise.all([
      client.getLaunchBuyersBatch(["mintA", "mintB"], 25),
      client.getLaunchBuyersBatch(["mintA"], 25),
    ]);
    expect(b.get("mintA")).toEqual(a.get("mintA"));
    expect(calls.filter((c) => c.params[0] === "mintA")).toHaveLength(1);
  });

  it("reads a launch again for a call that keeps its pages for the tape, or wants another count", async () => {
    const { url, calls } = await startServer(heliusHandler(), 20);
    const client = new HeliusClient({ rpcUrl: `${url}/?helius=1` });
    await Promise.all([
      client.getLaunchBuyersBatch(["mintA"], 25),
      client.getLaunchBuyersBatch(["mintA"], 25, { tapeSeeds: new Set(["mintA"]) }),
      client.getLaunchBuyersBatch(["mintA"], 10),
    ]);
    expect(calls.filter((c) => c.params[0] === "mintA")).toHaveLength(3);
  });
});
