import { describe, expect, it } from "vitest";
import {
  funderFromEarliestTransactions,
  funderFromFirstTransaction,
  HOT_FUNDER_DENYLIST,
  isHotFunder,
  linkedWallets,
} from "./linkedWallets.js";

const SOL = 1_000_000_000;
const notHot = () => false;

describe("funderFromFirstTransaction", () => {
  it("names the fee payer that sent the SOL", () => {
    const tx = {
      blockTime: 1_700_000_000,
      meta: { preBalances: [5 * SOL, 0, 1], postBalances: [3.99 * SOL, 1 * SOL, 1] },
      transaction: { message: { accountKeys: ["funder", "wallet", "system"] } },
    };
    expect(funderFromFirstTransaction("wallet", tx)).toEqual({
      funder: "funder",
      amountSol: 1,
      atMs: 1_700_000_000_000,
    });
  });

  it("falls back to the biggest sender when the wallet paid its own fee", () => {
    const tx = {
      meta: { preBalances: [0, 2 * SOL, 1 * SOL], postBalances: [0.5 * SOL, 1.5 * SOL, 1 * SOL] },
      transaction: { message: { accountKeys: ["wallet", "sender", "other"] } },
    };
    expect(funderFromFirstTransaction("wallet", tx)?.funder).toBe("sender");
  });

  it("finds nobody when the wallet received no SOL", () => {
    const tx = {
      meta: { preBalances: [1 * SOL, 0], postBalances: [1 * SOL - 5000, 0] },
      transaction: { message: { accountKeys: ["payer", "wallet"] } },
    };
    expect(funderFromFirstTransaction("wallet", tx)).toBeNull();
  });
});

describe("funderFromEarliestTransactions", () => {
  const keys = (accountKeys: string[], signers = 1) => ({
    message: { accountKeys, header: { numRequiredSignatures: signers } },
  });
  // Someone opened a token account for the wallet: it got no SOL.
  const opened = {
    meta: { preBalances: [5 * SOL, 0], postBalances: [4.99 * SOL, 0] },
    transaction: keys(["opener", "wallet"]),
  };

  it("walks past a first transaction that paid nothing in", () => {
    const funded = {
      meta: { preBalances: [3 * SOL, 0], postBalances: [2 * SOL, 1 * SOL] },
      transaction: keys(["F", "wallet"]),
    };
    expect(funderFromEarliestTransactions("wallet", [opened, funded])).toMatchObject({
      found: { funder: "F", amountSol: 1 },
      decided: true,
    });
  });

  it("stops at the wallet's own first signature, and never names a fee sponsor", () => {
    // A swap the wallet signed, its fee sponsored by a relayer: the pool paid out more than the
    // wallet got, so nobody funded it here.
    const swap = {
      meta: { preBalances: [1 * SOL, 0, 9 * SOL], postBalances: [1 * SOL, 0.002 * SOL, 8.9 * SOL] },
      transaction: keys(["relayer", "wallet", "pool"], 2),
    };
    const later = {
      meta: { preBalances: [3 * SOL, 0], postBalances: [2 * SOL, 1 * SOL] },
      transaction: keys(["G", "wallet"]),
    };
    expect(funderFromEarliestTransactions("wallet", [opened, swap, later])).toEqual({
      found: null,
      decided: true,
    });
    // A claim the wallet signed while a relayer paid the fee: the sender is the funder.
    const claim = {
      meta: { preBalances: [1 * SOL, 0, 2 * SOL], postBalances: [1 * SOL, 0.5 * SOL, 1.5 * SOL] },
      transaction: keys(["relayer", "wallet", "vault"], 2),
    };
    expect(funderFromEarliestTransactions("wallet", [claim]).found?.funder).toBe("vault");
  });

  it("is undecided when nothing given paid in and the wallet never signed", () => {
    expect(funderFromEarliestTransactions("wallet", [opened])).toEqual({ found: null, decided: false });
  });
});

describe("isHotFunder", () => {
  it("flags the denylist, a busy funder and one paying for many wallets", () => {
    expect(isHotFunder([...HOT_FUNDER_DENYLIST][0]!, { fullPageSpanMs: null })).toBe(true);
    expect(isHotFunder("x", { fullPageSpanMs: 3_600_000 })).toBe(true);
    expect(isHotFunder("x", { fullPageSpanMs: 30 * 86_400_000 })).toBe(false);
    expect(isHotFunder("x", { fullPageSpanMs: null, fundedLast24h: 51 })).toBe(true);
    expect(isHotFunder("x", { fullPageSpanMs: null, fundedLast24h: 4 })).toBe(false);
  });
});

describe("linkedWallets", () => {
  const holders = [
    { owner: "a", pct: 10 },
    { owner: "b", pct: 8 },
    { owner: "c", pct: 7 },
    { owner: "d", pct: 6 },
    { owner: "e", pct: 3 },
  ];

  it("clusters holders sharing a funder, and a holder that funded another", () => {
    const funders = new Map<string, string | null>([
      ["a", "F"],
      ["b", "F"],
      ["c", "d"],
      ["d", "G"],
      ["e", null],
    ]);
    const r = linkedWallets(holders, funders, { hot: notHot })!;
    expect(r.linkedClusterCount).toBe(2);
    expect(r.linkedLargestClusterPct).toBe(18);
    expect(r.linkedWalletPct).toBe(31);
    expect(r.clusters[0]).toMatchObject({ funder: "F", pct: 18 });
    expect(r.clusters[1]!.funder).toBe("d");
    expect(r.clusters[1]!.wallets.map((w) => w.wallet)).toEqual(["c", "d"]);
  });

  it("links nobody through a hot funder", () => {
    const funders = new Map<string, string | null>(holders.map((h) => [h.owner, "EXCHANGE"]));
    const r = linkedWallets(holders, funders, { hot: (f) => f === "EXCHANGE" })!;
    expect(r).toMatchObject({ linkedClusterCount: 0, linkedWalletPct: 0, linkedLargestClusterPct: 0 });
  });

  it("is unknown while any holder's funder is unread", () => {
    const funders = new Map<string, string | null>([["a", "F"]]);
    expect(linkedWallets(holders, funders, { hot: notHot })).toBeNull();
  });

  it("counts the supply tied to the creator, leaving the creator's own holding out", () => {
    const funders = new Map<string, string | null>([
      ["a", "creator"],
      ["b", "CF"],
      ["c", null],
      ["d", "Z"],
      ["e", null],
    ]);
    const r = linkedWallets([...holders, { owner: "creator", pct: 5 }], funders, {
      hot: notHot,
      creator: "creator",
      creatorFunder: "CF",
    })!;
    expect(r.linkedCreatorPct).toBe(18);
    expect(r.linkedWalletsChecked).toBe(5);
  });
});
