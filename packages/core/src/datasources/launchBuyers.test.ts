import { afterEach, describe, expect, it, vi } from "vitest";
import {
  blockZeroHeldPct,
  countHoldingSupplyCut,
  countStillHolding,
  devStillHolding,
  launchFigures,
  parseLaunchBuyers,
  sniperShareOfTop10,
  type RawLaunchTx,
} from "./launchBuyers.js";
import { HeliusClient } from "./helius.js";
import { resetLaunchTapeSeeds, takeLaunchTapeSeed } from "./launchTapeSeed.js";

const MINT = "Mint1111111111111111111111111111111111111pump";
const CURVE = "Curve11111111111111111111111111111111111111";
const DEV = "Dev111111111111111111111111111111111111111";

/** A transaction moving `mint` balances: [owner, account, pre, post] per holder it touches. */
function tx(
  moves: [string, string, number | null, number][],
  opts: { err?: unknown; at?: number; slot?: number } = {},
): RawLaunchTx {
  const keys = moves.map(([, account]) => account);
  return {
    blockTime: opts.at ?? 1_791_128_433,
    ...(opts.slot !== undefined ? { slot: opts.slot } : {}),
    meta: {
      err: opts.err ?? null,
      preTokenBalances: moves
        .map(([owner, , pre], i) => ({ owner, pre, i }))
        .filter((m) => m.pre !== null)
        .map(({ owner, pre, i }) => ({
          accountIndex: i,
          mint: MINT,
          owner,
          uiTokenAmount: { amount: String(pre) },
        })),
      postTokenBalances: moves.map(([owner, , , post], i) => ({
        accountIndex: i,
        mint: MINT,
        owner,
        uiTokenAmount: { amount: String(post) },
      })),
    },
    transaction: { message: { accountKeys: keys } },
  };
}

const create = tx([
  [CURVE, "curveAta", null, 800],
  [DEV, "devAta", null, 200],
]);
const buy = (wallet: string, amount: number, curveBefore = 800) =>
  tx([
    [CURVE, "curveAta", curveBefore, curveBefore - amount],
    [wallet, `${wallet}-ata`, null, amount],
  ]);

describe("blockZeroHeldPct", () => {
  const b0 = [
    { wallet: "a", tokenAccount: "a-ata", bought: 50, slot: 7 },
    { wallet: "b", tokenAccount: "b-ata", bought: 50, slot: 7 },
  ];
  it("sums what block zero's accounts hold now against the supply", () => {
    expect(
      blockZeroHeldPct(
        b0,
        new Map([
          ["a-ata", 30],
          ["b-ata", 0],
        ]),
        1000,
      ),
    ).toBe(3);
    expect(blockZeroHeldPct([], new Map(), 1000)).toBe(0);
  });
  it("is unknown with a balance missing or no supply", () => {
    expect(blockZeroHeldPct(b0, new Map([["a-ata", 30]]), 1000)).toBeNull();
    expect(
      blockZeroHeldPct(
        b0,
        new Map([
          ["a-ata", 30],
          ["b-ata", 0],
        ]),
        0,
      ),
    ).toBeNull();
  });
});

describe("parseLaunchBuyers", () => {
  it("lists the buyers after the create, in order, without the dev or the curve", () => {
    const sell = tx([
      [CURVE, "curveAta", 770, 780],
      ["a", "a-ata", 10, 0],
    ]);
    const devBuysMore = tx([
      [CURVE, "curveAta", 780, 770],
      [DEV, "devAta", 200, 210],
    ]);
    const reading = parseLaunchBuyers(
      MINT,
      [create, buy("a", 10), buy("b", 20, 790), sell, devBuysMore, buy("c", 5, 770)],
      25,
    );
    expect(reading?.buyers.map((b) => b.wallet)).toEqual(["a", "b", "c"]);
    expect(reading?.buyers[1]).toEqual({ wallet: "b", tokenAccount: "b-ata", bought: 20, slot: null });
    expect(reading?.launchAt).toEqual(new Date(1_791_128_433_000));
  });

  it("reads the supply, the dev's create buy and the slots, and turns them into figures", () => {
    const createAt = tx(
      [
        [CURVE, "curveAta", null, 800],
        [DEV, "devAta", null, 200],
      ],
      { slot: 100 },
    );
    const bundled = tx(
      [
        [CURVE, "curveAta", 800, 790],
        ["a", "a-ata", null, 10],
      ],
      { slot: 100 },
    );
    const later = tx(
      [
        [CURVE, "curveAta", 790, 750],
        ["b", "b-ata", null, 40],
      ],
      { slot: 103 },
    );
    const reading = parseLaunchBuyers(MINT, [createAt, bundled, later], 25)!;
    expect(reading.supply).toBe(1000);
    expect(reading.devBought).toBe(200);
    expect(reading.devAccounts).toEqual([{ wallet: DEV, tokenAccount: "devAta", bought: 200, slot: 100 }]);
    expect(reading.createSlot).toBe(100);
    expect(reading.buyers.map((b) => b.slot)).toEqual([100, 103]);
    expect(launchFigures(reading)).toEqual({
      firstBuyersSupplyPct: 5,
      launchBundledBuyers: 1,
      devBuySupplyPct: 20,
      blockZeroBuyers: 1,
      blockZeroBoughtPct: 1,
    });
    expect(reading.blockZeroBuyers).toEqual([{ wallet: "a", tokenAccount: "a-ata", bought: 10, slot: 100 }]);
  });

  it("figures: no dev buy reads 0, no slots leave the bundle unknown, no supply leaves all unknown", () => {
    const devless = parseLaunchBuyers(MINT, [tx([[CURVE, "curveAta", null, 1000]]), buy("a", 10, 1000)], 25)!;
    expect(devless.devBought).toBe(0);
    expect(devless.devAccounts).toEqual([]);
    expect(launchFigures(devless)).toEqual({
      firstBuyersSupplyPct: 1,
      launchBundledBuyers: null,
      devBuySupplyPct: 0,
      blockZeroBuyers: null,
      blockZeroBoughtPct: null,
    });
    expect(launchFigures({ buyers: [], supply: 0, devBought: 0, createSlot: null })).toEqual({
      firstBuyersSupplyPct: null,
      launchBundledBuyers: null,
      devBuySupplyPct: null,
      blockZeroBuyers: null,
      blockZeroBoughtPct: null,
    });
  });

  it("counts every block-zero buyer past the first-buyer cap, and only the create's slot", () => {
    const at = (slot: number, wallet: string, amount: number, before: number) =>
      tx(
        [
          [CURVE, "curveAta", before, before - amount],
          [wallet, `${wallet}-ata`, null, amount],
        ],
        { slot },
      );
    const createAt = tx(
      [
        [CURVE, "curveAta", null, 900],
        [DEV, "devAta", null, 100],
      ],
      { slot: 7 },
    );
    const reading = parseLaunchBuyers(
      MINT,
      [createAt, at(7, "a", 10, 900), at(7, "b", 20, 890), at(7, "c", 30, 870), at(8, "d", 40, 840)],
      2,
    )!;
    expect(reading.buyers.map((b) => b.wallet)).toEqual(["a", "b"]);
    expect(reading.blockZeroBuyers?.map((b) => b.wallet)).toEqual(["a", "b", "c"]);
    expect(launchFigures(reading)).toMatchObject({ blockZeroBuyers: 3, blockZeroBoughtPct: 6 });
    // Nobody sniped: a known zero, not unknown.
    const clean = parseLaunchBuyers(MINT, [createAt, at(9, "a", 10, 900)], 25)!;
    expect(launchFigures(clean)).toMatchObject({ blockZeroBuyers: 0, blockZeroBoughtPct: 0 });
  });

  it("stops at the count asked for and skips failed transactions", () => {
    const failed = {
      ...buy("x", 50),
      meta: { ...buy("x", 50).meta, err: { InstructionError: [2, { Custom: 6001 }] } },
    };
    const reading = parseLaunchBuyers(MINT, [create, failed, buy("a", 1), buy("b", 1), buy("c", 1)], 2);
    expect(reading?.buyers.map((b) => b.wallet)).toEqual(["a", "b"]);
  });

  it("adds a repeat buy to the buyer's total", () => {
    const reading = parseLaunchBuyers(
      MINT,
      [
        create,
        buy("a", 10),
        tx([
          [CURVE, "curveAta", 790, 785],
          ["a", "a-ata", 10, 15],
        ]),
      ],
      25,
    );
    expect(reading?.buyers).toEqual([{ wallet: "a", tokenAccount: "a-ata", bought: 15, slot: null }]);
  });

  it("refuses a history that doesn't start at the launch", () => {
    expect(parseLaunchBuyers(MINT, [buy("a", 10)], 25)).toBeNull();
    expect(parseLaunchBuyers(MINT, [], 25)).toBeNull();
  });

  it("resolves account indexes through lookup-table addresses (json encoding)", () => {
    const lut: RawLaunchTx = {
      blockTime: 1,
      meta: {
        err: null,
        preTokenBalances: [{ accountIndex: 1, mint: MINT, owner: CURVE, uiTokenAmount: { amount: "800" } }],
        postTokenBalances: [
          { accountIndex: 1, mint: MINT, owner: CURVE, uiTokenAmount: { amount: "790" } },
          { accountIndex: 2, mint: MINT, owner: "a", uiTokenAmount: { amount: "10" } },
        ],
        loadedAddresses: { writable: ["curveAta", "a-ata"], readonly: [] },
      },
      transaction: { message: { accountKeys: ["a"] } },
    };
    expect(parseLaunchBuyers(MINT, [create, lut], 25)?.buyers).toEqual([
      { wallet: "a", tokenAccount: "a-ata", bought: 10, slot: null },
    ]);
  });
});

describe("sniperShareOfTop10", () => {
  it("is the share of the holder list that were first buyers, unknown with no list", () => {
    const snipers = new Set(["a", "b", "c"]);
    expect(sniperShareOfTop10(["a", "b", "x", "y"], snipers)).toBe(50);
    expect(sniperShareOfTop10(["x"], snipers)).toBe(0);
    expect(sniperShareOfTop10([], snipers)).toBeNull();
  });
});

describe("countStillHolding", () => {
  const buyers = [
    { wallet: "a", tokenAccount: "a-ata", bought: 1000, slot: null },
    { wallet: "b", tokenAccount: "b-ata", bought: 1000, slot: null },
    { wallet: "c", tokenAccount: "c-ata", bought: 1000, slot: null },
  ];
  it("counts buyers above dust, a closed account as sold", () => {
    expect(
      countStillHolding(
        buyers,
        new Map([
          ["a-ata", 500],
          ["b-ata", 5],
          ["c-ata", 0],
        ]),
      ),
    ).toBe(1);
  });
  it("is unknown when any balance is missing", () => {
    expect(countStillHolding(buyers, new Map([["a-ata", 500]]))).toBeNull();
  });
});

describe("countHoldingSupplyCut", () => {
  const buyers = [
    { wallet: "a", tokenAccount: "a-ata", bought: 5000, slot: null },
    { wallet: "b", tokenAccount: "b-ata", bought: 5000, slot: null },
    { wallet: "c", tokenAccount: "c-ata", bought: 500, slot: null },
  ];
  it("counts buyers holding 0.1% of the supply or more, whatever they bought", () => {
    // Supply 1,000,000: the cut is 1,000. c still holds all it bought, but under the cut.
    expect(
      countHoldingSupplyCut(
        buyers,
        new Map([
          ["a-ata", 1000],
          ["b-ata", 999],
          ["c-ata", 500],
        ]),
        1_000_000,
      ),
    ).toBe(1);
  });
  it("is unknown when any balance or the supply is missing", () => {
    expect(countHoldingSupplyCut(buyers, new Map([["a-ata", 5000]]), 1_000_000)).toBeNull();
    const all = new Map([
      ["a-ata", 5000],
      ["b-ata", 5000],
      ["c-ata", 500],
    ]);
    expect(countHoldingSupplyCut(buyers, all, 0)).toBeNull();
  });
});

describe("HeliusClient.getLaunchBuyersBatch", () => {
  afterEach(() => {
    resetLaunchTapeSeeds();
    vi.restoreAllMocks();
  });
  const client = () => new HeliusClient({ rpcUrl: "https://mainnet.helius-rpc.com/?api-key=test" });

  function respond(pages: { data: RawLaunchTx[]; paginationToken?: string }[]) {
    const bodies: unknown[] = [];
    let call = 0;
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const batch = JSON.parse(String(init?.body)) as { id: string; params: unknown[] }[];
      bodies.push(batch);
      const page = pages[Math.min(call++, pages.length - 1)]!;
      return new Response(JSON.stringify(batch.map((c) => ({ jsonrpc: "2.0", id: c.id, result: page }))), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    return { spy, bodies };
  }

  it("reads one page oldest-first, successful only, and stops once the history ends", async () => {
    const { bodies } = respond([{ data: [create, buy("a", 10)] }]);
    const out = await client().getLaunchBuyersBatch([MINT], 25, { tapeSeeds: new Set([MINT]) });
    expect(out.get(MINT)).toMatchObject({ status: "found", complete: false, buyers: [{ wallet: "a" }] });
    expect(bodies).toHaveLength(1);
    const params = (bodies[0] as { params: [string, Record<string, unknown>] }[])[0]!.params;
    expect(params[0]).toBe(MINT);
    expect(params[1]).toMatchObject({
      transactionDetails: "full",
      sortOrder: "asc",
      limit: 100,
      filters: { status: "succeeded" },
    });
    const seed = takeLaunchTapeSeed(MINT, 60_000);
    expect(seed).toMatchObject({ pages: 1, paginationToken: null });
    expect(seed?.txs).toHaveLength(2);
  });

  it("keeps the token of a short page in the seed, since a young coin's history goes on", async () => {
    respond([{ data: [create, buy("a", 10)], paginationToken: "p2" }]);
    const out = await client().getLaunchBuyersBatch([MINT], 25, { tapeSeeds: new Set([MINT]) });
    // The launch-buyer reading still ends here: the history has ended so far.
    expect(out.get(MINT)).toMatchObject({ status: "found", complete: false });
    expect(takeLaunchTapeSeed(MINT, 60_000)).toMatchObject({ pages: 1, paginationToken: "p2" });
  });

  it("keeps no tape seed for a mint the caller didn't name", async () => {
    respond([{ data: [create, buy("a", 10)] }]);
    const out = await client().getLaunchBuyersBatch([MINT], 25);
    expect(out.get(MINT)).toMatchObject({ status: "found" });
    expect(takeLaunchTapeSeed(MINT, 60_000)).toBeUndefined();
  });

  it("pages on while a full page hasn't reached the count, then calls it complete at the cap", async () => {
    const filler = Array.from({ length: 99 }, () => tx([[DEV, "devAta", 200, 200]]));
    const { bodies } = respond([
      { data: [create, ...filler], paginationToken: "p2" },
      { data: [buy("a", 1), ...filler], paginationToken: "p3" },
      { data: [buy("b", 1), ...filler], paginationToken: "p4" },
    ]);
    const out = await client().getLaunchBuyersBatch([MINT], 25);
    expect(bodies).toHaveLength(3);
    expect((bodies[1] as { params: [string, Record<string, unknown>] }[])[0]!.params[1].paginationToken).toBe(
      "p2",
    );
    expect(out.get(MINT)).toMatchObject({ status: "found", complete: true });
    const found = out.get(MINT);
    expect(found?.status === "found" && found.buyers.map((b) => b.wallet)).toEqual(["a", "b"]);
  });

  it("calls a history that doesn't start at a launch complete with no buyers, so it isn't re-read", async () => {
    // The first transaction is fixed, so a history that can't be parsed never will be - and
    // retrying it every five minutes cost 10-30 credits a time for the same answer.
    // Someone already held the mint before its first recorded transaction: not a launch.
    respond([{ data: [tx([["someone", "someoneAta", 5, 7]])] }]);
    expect((await client().getLaunchBuyersBatch([MINT], 25)).get(MINT)).toEqual({
      status: "found",
      complete: true,
      buyers: [],
      launchAt: null,
      supply: 0,
      devBought: 0,
      createSlot: null,
    });
  });

  it("keeps the pages already read when a later page fails", async () => {
    const filler = Array.from({ length: 96 }, () => tx([[DEV, "devAta", 200, 200]]));
    let call = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const batch = JSON.parse(String(init?.body)) as { id: string }[];
      call += 1;
      const body =
        call === 1
          ? batch.map((c) => ({
              jsonrpc: "2.0",
              id: c.id,
              result: {
                data: [create, buy("a", 1), buy("b", 1), buy("c", 1), ...filler],
                paginationToken: "p2",
              },
            }))
          : batch.map((c) => ({ jsonrpc: "2.0", id: c.id, error: { code: -32000, message: "busy" } }));
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const r = (await client().getLaunchBuyersBatch([MINT], 25)).get(MINT)!;
    expect(r.status).toBe("found");
    if (r.status === "found") {
      expect(r.complete).toBe(false);
      expect(r.buyers.length).toBe(3);
    }
  });

  it("reports a launch it can't read as failed, and a non-Helius endpoint as unsupported", async () => {
    respond([{ data: [] }]);
    expect((await client().getLaunchBuyersBatch([MINT], 25)).get(MINT)).toEqual({ status: "failed" });
    const plain = new HeliusClient({ rpcUrl: "https://solana-rpc.publicnode.com" });
    expect((await plain.getLaunchBuyersBatch([MINT], 25)).get(MINT)).toEqual({ status: "unsupported" });
  });
});

describe("devStillHolding", () => {
  const dev = [
    { wallet: DEV, tokenAccount: "devAta", bought: 200, slot: null },
    { wallet: "dev2", tokenAccount: "dev2Ata", bought: 100, slot: null },
  ];

  it("holds while more than dust of the launch buy is left, across the dev's accounts", () => {
    expect(
      devStillHolding(
        dev,
        new Map([
          ["devAta", 0],
          ["dev2Ata", 50],
        ]),
      ),
    ).toBe(true);
    expect(
      devStillHolding(
        dev,
        new Map([
          ["devAta", 2],
          ["dev2Ata", 0],
        ]),
      ),
    ).toBe(false);
    expect(
      devStillHolding(
        dev,
        new Map([
          ["devAta", 0],
          ["dev2Ata", 0],
        ]),
      ),
    ).toBe(false);
  });

  it("is unknown with no launch buy or a missing balance", () => {
    expect(devStillHolding([], new Map())).toBeNull();
    expect(devStillHolding(undefined, new Map())).toBeNull();
    expect(devStillHolding(dev, new Map([["devAta", 200]]))).toBeNull();
  });
});
