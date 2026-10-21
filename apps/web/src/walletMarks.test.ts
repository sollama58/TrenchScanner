import { describe, expect, it } from "vitest";
import { DEFAULT_APPEARANCE, normalizeAppearance, withPreset } from "./appearance";
import {
  clampMinSol,
  keepMarkSources,
  kindsOf,
  labelAvatars,
  markPrefsOf,
  MIN_SOL_FLOOR,
  walletMarks,
  withAvatars,
  picWallets,
  withLabeledTraders,
  withLiveMarks,
  type MarkSource,
} from "./walletMarks";

const kol: MarkSource = {
  wallet: "KoLwallet1111111111111111111111111111111111",
  tags: ["kol"],
  kol: "Cupsey",
  trades: [
    [1_000, 1, 2],
    [2_000, -1, 0.3],
    [3_000, -1, 0.1],
    [4_000, 1, null],
  ],
};
const side: MarkSource = {
  wallet: "Side111111111111111111111111111111111111111",
  tags: ["side"],
  side: { kind: "probable", kolWallet: kol.wallet, kolName: "Cupsey" },
  trades: [[1_500, 1, 0.6]],
};
const devRisky: MarkSource = {
  wallet: "Dev1111111111111111111111111111111111111111",
  tags: ["creator", "risky"],
  trades: [[500, 1, 5]],
};
const defaults = markPrefsOf(DEFAULT_APPEARANCE);

describe("walletMarks", () => {
  it("defaults to every kind at 0.5 SOL, dropping smaller trades and ones of unknown size", () => {
    const out = walletMarks([kol, side, devRisky], defaults);
    expect(out.map((m) => [m.t, m.kind, m.side])).toEqual([
      [500, "dev", "buy"],
      [1_000, "kol", "buy"],
      [1_500, "probable", "buy"],
    ]);
    expect(out[1]!.text).toBe("Cupsey (KOL) bought 2.00 SOL");
  });

  it("never marks a trade under the 0.25 SOL floor, whatever the setting", () => {
    const out = walletMarks([kol], { ...defaults, minSol: 0 });
    expect(out.map((m) => m.t)).toEqual([1_000, 2_000]);
    expect(out.every((m) => m.sol >= MIN_SOL_FLOOR)).toBe(true);
  });

  it("shows only the chosen kinds, marking a wallet as its strongest shown kind", () => {
    expect(walletMarks([kol, side, devRisky], { ...defaults, kinds: ["risky"] })).toMatchObject([
      { wallet: devRisky.wallet, kind: "risky", letter: "R" },
    ]);
    expect(walletMarks([kol, side], { ...defaults, on: false })).toEqual([]);
    expect(walletMarks([kol], defaults, new Set([kol.wallet]))).toEqual([]);
  });

  it("keeps a known dumper hidden while dumpers are off, whatever else it is", () => {
    const linkedDumper: MarkSource = {
      wallet: "Dump111111111111111111111111111111111111111",
      tags: ["linked", "dumper"],
      trades: [[700, -1, 3]],
    };
    expect(walletMarks([linkedDumper], defaults)).toEqual([]);
    expect(walletMarks([linkedDumper], { ...defaults, kinds: [...defaults.kinds, "risky"] })).toHaveLength(1);
  });

  it("reads a Known Side as one, not as a KOL", () => {
    expect(kindsOf({ ...kol, knownSideOf: "Main" })).toEqual(["known"]);
    expect(kindsOf(devRisky)).toEqual(["dev", "risky"]);
  });
});

describe("chart mark settings", () => {
  it("clamps a typed size to the floor and reads bad input as the default", () => {
    expect(clampMinSol(0.1)).toBe(0.25);
    expect(clampMinSol("1.5")).toBe(1.5);
    expect(clampMinSol("abc")).toBe(0.5);
    expect(clampMinSol("")).toBe(0.5);
  });

  it("reads a saved appearance leniently: unknown kinds dropped, the size held to the floor", () => {
    const look = normalizeAppearance({
      chartMarks: false,
      chartMarkKinds: ["kol", "nope"],
      chartMarkMinSol: 0,
    });
    expect(markPrefsOf(look)).toEqual({ on: false, kinds: ["kol"], minSol: 0.25 });
    expect(markPrefsOf(normalizeAppearance({}))).toEqual(defaults);
    expect(defaults).toMatchObject({ on: true, minSol: 0.5 });
    expect(defaults.kinds).toHaveLength(6);
    expect(defaults.kinds).not.toContain("risky");
    expect(defaults.kinds).not.toContain("winner");
  });

  it("turns risky wallets off for a look saved with every kind still on, and only then", () => {
    const all = ["kol", "known", "funded", "probable", "dev", "risky", "winner", "linked"];
    expect(normalizeAppearance({ chartMarkKinds: all }).chartMarkKinds).not.toContain("risky");
    expect(normalizeAppearance({ chartMarkKinds: all }).chartMarkKinds).not.toContain("winner");
    // Switched back on since: saved against the new default, it stays on.
    const back = normalizeAppearance({ ...normalizeAppearance({}), chartMarkKinds: all });
    expect(back.chartMarkKinds).toContain("risky");
    expect(back.chartMarkKinds).toContain("winner");
    expect(normalizeAppearance(back).chartMarkKinds).toContain("risky");
    // A list the reader changed otherwise keeps risky wallets as they left them.
    expect(normalizeAppearance({ chartMarkKinds: ["kol", "risky"] }).chartMarkKinds).toEqual([
      "kol",
      "risky",
    ]);
  });

  it("turns winners off for a look still on the previous default, and keeps a later choice", () => {
    const rev2 = ["kol", "known", "funded", "probable", "dev", "winner", "linked"];
    expect(normalizeAppearance({ chartMarkKinds: rev2, chartMarksRev: 2 }).chartMarkKinds).not.toContain(
      "winner",
    );
    // Risky switched back on against rev 2 stays on; winners were still the default, so they go off.
    const all = ["kol", "known", "funded", "probable", "dev", "risky", "winner", "linked"];
    const riskyOn = normalizeAppearance({ chartMarkKinds: all, chartMarksRev: 2 });
    expect(riskyOn.chartMarkKinds).toContain("risky");
    expect(riskyOn.chartMarkKinds).not.toContain("winner");
    // The reader turned winners on after this default: the saved revision keeps them.
    const chosen = normalizeAppearance({
      ...normalizeAppearance({}),
      chartMarkKinds: [...rev2],
    });
    expect(chosen.chartMarkKinds).toContain("winner");
    expect(normalizeAppearance(chosen).chartMarkKinds).toContain("winner");
    // A list they edited otherwise keeps winners as they left them.
    expect(
      normalizeAppearance({ chartMarkKinds: ["kol", "winner"], chartMarksRev: 2 }).chartMarkKinds,
    ).toEqual(["kol", "winner"]);
  });

  it("keeps risky and winner when the look was saved at chart marks revision 3", () => {
    // 2026-10-21 user ask: revision 3 is its own case, not only a round trip through a fresh save.
    const all = ["kol", "known", "funded", "probable", "dev", "risky", "winner", "linked"];
    const look = normalizeAppearance({ chartMarkKinds: all, chartMarksRev: 3 });
    expect(look.chartMarkKinds).toContain("risky");
    expect(look.chartMarkKinds).toContain("winner");
    expect(look.chartMarksRev).toBe(3);
  });
});

describe("labeled wallets' marks", () => {
  const prefs = { on: true, kinds: ["kol", "funded"] as const, minSol: 0.25 };
  it("marks a User Tracked wallet with the KOLs as T, and its funded wallets as T without KOL", () => {
    const mine: MarkSource = {
      wallet: "Mine111111111111111111111111111111111111111",
      tags: ["tracked"],
      tracked: "Whale",
      trades: [[1_000, 1, 2]],
    };
    const funded: MarkSource = {
      wallet: "Fund111111111111111111111111111111111111111",
      tags: ["side"],
      side: { kind: "funded", kolWallet: mine.wallet, kolName: "Whale", tracked: "tracked" },
      trades: [[2_000, 1, 1]],
    };
    expect(kindsOf(mine)).toEqual(["kol"]);
    const marks = walletMarks([mine, funded], { ...prefs, kinds: [...prefs.kinds] });
    expect(marks.map((m) => [m.letter, m.text])).toEqual([
      ["T", "Whale (Tracked) bought 2.00 SOL"],
      ["T", "Whale Funded Wallet Fund…1111 bought 1.00 SOL"],
    ]);
  });
});

describe("withLiveMarks", () => {
  const kolRow = { wallet: "K1", tags: ["kol"], kol: "Cupsey", trades: [[1_000, 1, 2]] as const };
  it("adds live trades the rows don't hold, once", () => {
    const out = withLiveMarks(
      [kolRow],
      [
        { wallet: "K1", side: "buy", sol: 2, atMs: 2_000 },
        { wallet: "K1", side: "sell", sol: 1.5, atMs: 60_000 },
      ],
      {},
    );
    expect(out[0]?.trades).toEqual([
      [1_000, 1, 2],
      [60_000, -1, 1.5],
    ]);
  });
  it("adds traders the chart doesn't flag when their name says KOL, Known Side or tracked", () => {
    const out = withLiveMarks(
      [],
      [
        { wallet: "A", side: "buy", sol: 3, atMs: 1 },
        { wallet: "B", side: "buy", sol: 3, atMs: 1 },
        { wallet: "C", side: "buy", sol: 3, atMs: 1 },
        { wallet: "D", side: "buy", sol: 3, atMs: 1 },
      ],
      {
        A: { name: "Cupsey", source: "kol" },
        B: { name: "Cupsey Known Side", source: "kol-side" },
        C: { name: "my whale", source: "tracked" },
        D: { name: "Binance", source: "exchange" },
      },
    );
    const marks = walletMarks(out, { on: true, kinds: ["kol", "known"], minSol: 0.5 });
    expect(marks.map((m) => [m.wallet, m.letter, m.text])).toEqual([
      ["A", "K", "Cupsey (KOL) bought 3.00 SOL"],
      ["B", "K", "Cupsey Known Side bought 3.00 SOL"],
      ["C", "T", "my whale (Tracked) bought 3.00 SOL"],
    ]);
  });
  it("adds a KOL's funded wallet or Probable Side by its tie, lettered K like the KOL", () => {
    const out = withLiveMarks(
      [],
      [
        { wallet: "F", side: "buy", sol: 1, atMs: 1 },
        { wallet: "P", side: "sell", sol: 1, atMs: 2 },
      ],
      {},
      {
        F: [
          { kolWallet: "K", kolName: "Cupsey", pct: 0.9 } as never,
          { kolWallet: "K", kolName: "Cupsey", funded: true },
        ],
        P: [{ kolWallet: "K", kolName: "Cupsey" }],
      },
    );
    const marks = walletMarks(out, { on: true, kinds: ["funded", "probable"], minSol: 0.5 });
    expect(marks.map((m) => [m.wallet, m.letter, m.picFrom])).toEqual([
      ["F", "K", "K"],
      ["P", "K", "K"],
    ]);
  });
});

describe("withAvatars", () => {
  it("gives a KOL's marks and its sides' the KOL's picture, and no other kind", () => {
    const known: MarkSource = {
      wallet: "Known11111111111111111111111111111111111111",
      tags: ["kol"],
      kol: "Cupsey",
      knownSideOf: kol.wallet,
      trades: [[1_700, 1, 1]],
    };
    const marks = walletMarks([kol, side, known, devRisky], defaults);
    expect(picWallets(marks).sort()).toEqual([kol.wallet, known.wallet].sort());
    const out = withAvatars(marks, {
      [kol.wallet]: { avatar: "/kol-avatars/cupsey?v=1" },
      [side.wallet]: { avatar: "/kol-avatars/other?v=1" },
      [devRisky.wallet]: { avatar: "/kol-avatars/dev?v=1" },
    });
    expect(out.map((m) => [m.kind, m.avatar])).toEqual([
      ["dev", undefined],
      ["kol", "/kol-avatars/cupsey?v=1"],
      ["probable", "/kol-avatars/cupsey?v=1"],
      ["known", "/kol-avatars/cupsey?v=1"],
    ]);
  });

  it("leaves marks without a picture as they were", () => {
    const marks = walletMarks([kol], defaults);
    expect(withAvatars(marks, {})).toEqual(marks);
  });
});

describe("appearance chartMarkPics", () => {
  it("is on by default and keeps a saved choice", () => {
    expect(DEFAULT_APPEARANCE.chartMarkPics).toBe(true);
    expect(normalizeAppearance({}).chartMarkPics).toBe(true);
    expect(normalizeAppearance({ chartMarkPics: false }).chartMarkPics).toBe(false);
  });
});

describe("appearance chartMarkScale", () => {
  it("is medium by default and keeps a saved size", () => {
    expect(DEFAULT_APPEARANCE.chartMarkScale).toBe("m");
    expect(normalizeAppearance({}).chartMarkScale).toBe("m");
    expect(normalizeAppearance({ chartMarkScale: "l" }).chartMarkScale).toBe("l");
    expect(normalizeAppearance({ chartMarkScale: "huge" }).chartMarkScale).toBe("m");
  });
});

describe("appearance chart mark style", () => {
  it("defaults to a circle, no line and a medium gap, and keeps a saved choice", () => {
    expect(DEFAULT_APPEARANCE).toMatchObject({
      chartMarkShape: "circle",
      chartMarkStem: false,
      chartMarkGap: "m",
    });
    expect(normalizeAppearance({})).toMatchObject({
      chartMarkShape: "circle",
      chartMarkStem: false,
      chartMarkGap: "m",
    });
    expect(
      normalizeAppearance({ chartMarkShape: "diamond", chartMarkStem: true, chartMarkGap: "l" }),
    ).toMatchObject({ chartMarkShape: "diamond", chartMarkStem: true, chartMarkGap: "l" });
    expect(normalizeAppearance({ chartMarkShape: "square", chartMarkGap: "s" })).toMatchObject({
      chartMarkShape: "square",
      chartMarkGap: "s",
    });
    expect(
      normalizeAppearance({ chartMarkShape: "star", chartMarkStem: "yes", chartMarkGap: "xl" }),
    ).toMatchObject({ chartMarkShape: "circle", chartMarkStem: false, chartMarkGap: "m" });
  });

  it("keeps a saved mark style through a preset", () => {
    const look = normalizeAppearance({ chartMarkShape: "square", chartMarkStem: true, chartMarkGap: "s" });
    expect(withPreset(look, { density: "compact" })).toMatchObject({
      chartMarkShape: "square",
      chartMarkStem: true,
      chartMarkGap: "s",
      density: "compact",
    });
  });
});

describe("keepMarkSources", () => {
  const a: MarkSource = { wallet: "A", tags: ["kol"], kol: "Cupsey", trades: [[1_000, 1, 1]] };
  const b: MarkSource = { wallet: "B", tags: ["linked"], trades: [[2_000, -1, 1]] };
  it("keeps a wallet a later read left out, and the trades of every read", () => {
    const next = [{ ...a, kol: "Cupsey2", trades: [[3_000, -1, 2]] as MarkSource["trades"] }];
    const out = keepMarkSources([a, b], next);
    expect(out.map((w) => [w.wallet, w.kol, w.trades.map((t) => t[0])])).toEqual([
      ["A", "Cupsey2", [1_000, 3_000]],
      ["B", undefined, [2_000]],
    ]);
  });
  it("keeps the newest read as it is when it holds everything", () => {
    const next = [a, b];
    expect(keepMarkSources([a], next)).toEqual(next);
    expect(keepMarkSources([], next)).toBe(next);
  });
});

describe("withLabeledTraders", () => {
  const labels = {
    K: { name: { name: "Cupsey", source: "kol" as const, avatar: "/kol-avatars/cupsey" } },
    S: { name: { name: "Cupsey Known Side", source: "kol-side" as const } },
    F: { side: { kolWallet: "K", kolName: "Cupsey", funded: true, avatar: "/kol-avatars/cupsey" } },
    R: { risky: true, winner: true },
    D: { dumper: true },
    A: { name: { name: "Ansem", source: "kol" as const } },
  };
  it("adds the live feed's labeled traders the chart doesn't flag, and marks their live trades", () => {
    const flagged: MarkSource[] = [{ wallet: "A", tags: ["linked"], trades: [] }];
    const wallets = withLabeledTraders(flagged, labels);
    const out = withLiveMarks(
      wallets,
      ["K", "S", "F", "R", "D", "A"].map((wallet, i) => ({ wallet, side: "buy" as const, sol: 2, atMs: i })),
      {},
    );
    const marks = walletMarks(out, {
      on: true,
      kinds: ["kol", "known", "funded", "risky", "winner", "linked"],
      minSol: 0.5,
    });
    expect(marks.map((m) => [m.wallet, m.kind, m.letter])).toEqual([
      ["K", "kol", "K"],
      ["S", "known", "K"],
      ["F", "funded", "K"],
      ["R", "risky", "R"],
      ["D", "risky", "R"],
      // Already flagged by the chart: kept as the chart has it.
      ["A", "linked", "L"],
    ]);
    expect(marks[1]!.text).toBe("Cupsey Known Side bought 2.00 SOL");
  });
  it("gives the KOL pictures the labels carry, a side's under its KOL", () => {
    expect(labelAvatars(labels)).toEqual({ K: { avatar: "/kol-avatars/cupsey" } });
  });
});
