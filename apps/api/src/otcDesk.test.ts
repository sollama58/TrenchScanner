import { describe, expect, it, vi } from "vitest";
import { feeDesksFromOtcRoster, resolveOtcDeskFee } from "./feeDesks.js";
import {
  clearOtcDeskSingles,
  fetchOtcDeskRoster,
  otcDeskFeeForMint,
  otcDeskFees,
  otcDeskRosterFor,
  otcRosterCacheMs,
  sweepOtcRoster,
  type OtcRosterSweep,
} from "./otcDesk.js";

const MINT = "MukLDtJ8Cx9DxLbeyLRSWPSposTMWuwHANbuaudpump";
const NVDA = "So11111111111111111111111111111111111111112";
const TSLA = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function filler(n: number): string {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const a = alphabet[n % alphabet.length] ?? "1";
  const b = alphabet[Math.floor(n / alphabet.length) % alphabet.length] ?? "1";
  return `${a}${b}${"1".repeat(30)}`;
}

function fullPage(page: number): { mint: string; symbol: string }[] {
  return Array.from({ length: 12 }, (_, i) => ({ mint: filler(page * 12 + i), symbol: "X" }));
}

describe("fetchOtcDeskRoster", () => {
  it("reads the reward the public roster names and ignores a coin with none", async () => {
    const fetchImpl = async () =>
      new Response(
        JSON.stringify({
          coins: [
            { mint: MINT, rewardSymbol: "NVDAx" },
            { mint: "So11111111111111111111111111111111111111112", name: "no reward" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    expect([...(await fetchOtcDeskRoster(fetchImpl as typeof fetch)).entries()]).toEqual([
      [MINT, { line: "OTC Desks pays holder rewards in NVDAx.", rewards: [{ label: "NVDAx", mint: null }] }],
    ]);
  });

  it("names each coin when the roster's reward basket has several", async () => {
    const fetchImpl = async () =>
      new Response(
        JSON.stringify({
          coins: [
            { mint: MINT, rewardBasket: [NVDA, TSLA] },
            { mint: NVDA, symbol: "NVDAx", name: "NVIDIA" },
            { mint: TSLA, symbol: "TSLAx" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    expect([...(await fetchOtcDeskRoster(fetchImpl as typeof fetch)).entries()]).toEqual([
      [
        MINT,
        {
          line: "OTC Desks pays holder rewards in NVDAx and TSLAx.",
          rewards: [
            { label: "NVDAx", mint: NVDA },
            { label: "TSLAx", mint: TSLA },
          ],
        },
      ],
    ]);
  });

  it("shows nothing when the roster does not answer", async () => {
    const fetchImpl = async () => new Response("no", { status: 503 });
    expect((await fetchOtcDeskRoster(fetchImpl as typeof fetch)).size).toBe(0);
  });

  it("matches a creator-reward pump coin that is only on a later roster page", async () => {
    const featured = "So11111111111111111111111111111111111111113";
    const filler = (i: number) => `${"123456789ABCDEFGHJKLMNPQRSTUVWXYZ"[i] ?? "1"}${"1".repeat(31)}`;
    const fetchImpl = async (input: string | URL | Request) => {
      const url = new URL(String(input));
      expect(url.hostname).toBe("otcdesks.cash");
      const page = url.searchParams.get("page");
      if (!page) {
        return new Response(JSON.stringify({ coins: [{ mint: featured, symbol: "HOT" }] }), { status: 200 });
      }
      if (page === "1") {
        return new Response(
          JSON.stringify({ coins: Array.from({ length: 12 }, (_, i) => ({ mint: filler(i), symbol: "X" })) }),
          { status: 200 },
        );
      }
      if (page === "2") {
        return new Response(
          JSON.stringify({
            coins: [
              { mint: MINT, rewardBasket: [NVDA, TSLA] },
              { mint: NVDA, symbol: "NVDAx" },
              { mint: TSLA, symbol: "TSLAx" },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ coins: [] }), { status: 200 });
    };
    const fees = await fetchOtcDeskRoster(fetchImpl as typeof fetch);
    expect(fees.get(MINT)).toEqual({
      line: "OTC Desks pays holder rewards in NVDAx and TSLAx.",
      rewards: [
        { label: "NVDAx", mint: NVDA },
        { label: "TSLAx", mint: TSLA },
      ],
    });
    expect(fees.has(featured)).toBe(false);
  });

  it("keeps walking when page 1 repeats the featured mints and a later page has the basket", async () => {
    const featured = [
      { mint: MINT, name: "Launch" },
      { mint: NVDA, symbol: "NVDAx" },
      { mint: TSLA, symbol: "TSLAx" },
    ];
    const fetchImpl = async (input: string | URL | Request) => {
      const page = new URL(String(input)).searchParams.get("page");
      if (!page) return json({ coins: featured });
      if (page === "1") return json({ coins: featured });
      if (page === "2") return json({ coins: [{ mint: MINT, rewardBasket: [NVDA, TSLA] }] });
      return json({ coins: [] });
    };
    expect((await fetchOtcDeskRoster(fetchImpl as typeof fetch)).get(MINT)).toEqual({
      line: "OTC Desks pays holder rewards in NVDAx and TSLAx.",
      rewards: [
        { label: "NVDAx", mint: NVDA },
        { label: "TSLAx", mint: TSLA },
      ],
    });
  });

  it("does not end the sweep on a JSON body that is not a roster", async () => {
    const calls = new Map<string, number>();
    const fetchImpl = async (input: string | URL | Request) => {
      const page = new URL(String(input)).searchParams.get("page") ?? "featured";
      calls.set(page, (calls.get(page) ?? 0) + 1);
      if (!new URL(String(input)).searchParams.get("page"))
        return json({ coins: [{ mint: "featured-only" }] });
      if (page === "1") return json({ coins: fullPage(1) });
      if (page === "2") return json({ nope: true });
      if (page === "3") {
        return json({
          coins: [
            { mint: MINT, rewardBasket: [NVDA, TSLA] },
            { mint: NVDA, symbol: "NVDAx" },
            { mint: TSLA, symbol: "TSLAx" },
          ],
        });
      }
      return json({ coins: [] });
    };
    expect((await fetchOtcDeskRoster(fetchImpl as typeof fetch)).get(MINT)?.line).toBe(
      "OTC Desks pays holder rewards in NVDAx and TSLAx.",
    );
    expect(calls.get("2")).toBe(2);
  });

  it("does not keep coins from a page after the list has ended", async () => {
    const late = `L${"1".repeat(31)}`;
    const seen = new Set<string>();
    const fetchImpl = async (input: string | URL | Request) => {
      const page = new URL(String(input)).searchParams.get("page") ?? "featured";
      seen.add(page);
      if (page === "featured") return json({ coins: [{ mint: NVDA, symbol: "NVDAx" }] });
      if (page === "1") return json({ coins: fullPage(1) });
      if (page === "2") return json({ coins: [] });
      if (page === "3") return json({ coins: [{ mint: late, rewardSymbol: "NVDAx" }] });
      return json({ coins: [] });
    };
    const fees = await fetchOtcDeskRoster(fetchImpl as typeof fetch);
    expect(fees.has(late)).toBe(false);
    expect(seen.has("10")).toBe(false);
  });

  it("keeps walking a short page when the body names a larger catalog", async () => {
    const fetchImpl = async (input: string | URL | Request) => {
      const page = new URL(String(input)).searchParams.get("page");
      if (!page) return json({ coins: [{ mint: NVDA, symbol: "NVDAx" }], total: 30 });
      if (page === "1") return json({ coins: fullPage(1).slice(0, 3), total: 30 });
      if (page === "2") {
        return json({
          coins: [
            { mint: MINT, rewardBasket: [NVDA, TSLA] },
            { mint: TSLA, symbol: "TSLAx" },
          ],
          total: 30,
        });
      }
      return json({ coins: [], total: 30 });
    };
    expect((await fetchOtcDeskRoster(fetchImpl as typeof fetch)).get(MINT)?.line).toBe(
      "OTC Desks pays holder rewards in NVDAx and TSLAx.",
    );
  });

  it("stops on a short page of new launches", async () => {
    const late = `L${"1".repeat(31)}`;
    const fetchImpl = async (input: string | URL | Request) => {
      const page = new URL(String(input)).searchParams.get("page");
      if (!page) return json({ coins: [] });
      if (page === "1")
        return json({ coins: [{ mint: MINT, rewardSymbol: "NVDAx" }, ...fullPage(1).slice(0, 2)] });
      return json({ coins: [{ mint: late, rewardSymbol: "TSLAx" }] });
    };
    const fees = await fetchOtcDeskRoster(fetchImpl as typeof fetch);
    expect(fees.get(MINT)?.line).toBe("OTC Desks pays holder rewards in NVDAx.");
    expect(fees.has(late)).toBe(false);
  });
});

describe("otcRosterCacheMs", () => {
  it("does not treat a partial roster as a fifteen-minute hit", () => {
    expect(otcRosterCacheMs({ complete: true, size: 4 })).toBe(15 * 60_000);
    expect(otcRosterCacheMs({ complete: false, size: 4 })).toBe(60_000);
    expect(otcRosterCacheMs({ complete: true, size: 0 })).toBe(60_000);
  });
});

/**
 * A host with `launches` (newest first) in 12-coin pages, the newest 3 as the featured set. Each
 * request is logged by page ("featured" for the bare GET); `failing` pages answer 503.
 */
function host(launches: { mint: string; symbol?: string; rewardSymbol?: string }[]) {
  const asked: string[] = [];
  const failing = new Set<string>();
  const fetchImpl = (async (input: string | URL | Request) => {
    const page = new URL(String(input)).searchParams.get("page") ?? "featured";
    asked.push(page);
    if (failing.has(page)) return new Response("down", { status: 503 });
    if (page === "featured") return json({ coins: launches.slice(0, 3) });
    const n = Number(page);
    return json({ coins: launches.slice((n - 1) * 12, n * 12), total: launches.length });
  }) as typeof fetch;
  return { fetchImpl, asked, failing };
}

const launch = (n: number): { mint: string; symbol: string; rewardSymbol?: string } => ({
  mint: filler(n),
  symbol: `C${n}`,
});

describe("sweepOtcRoster (user ask 2026-10-23: API audit bundle)", () => {
  const T0 = 1_000_000_000;

  it("reads only the newest pages once the roster is filled, and adds new launches on top", async () => {
    const launches = Array.from({ length: 50 }, (_, i) => launch(i));
    launches[40] = { ...launches[40]!, rewardSymbol: "NVDAx" };
    const h = host(launches);
    const first = await sweepOtcRoster(null, h.fetchImpl, T0);
    expect(first.complete).toBe(true);
    expect(feeDesksFromOtcRoster({ coins: first.coins }).get(filler(40))?.line).toBe(
      "OTC Desks pays holder rewards in NVDAx.",
    );
    // Nothing new: the featured set and page 1, which holds only coins already kept.
    h.asked.length = 0;
    const quiet = await sweepOtcRoster(first.state, h.fetchImpl, T0 + 15 * 60_000);
    expect(h.asked).toEqual(["featured", "1"]);
    expect(quiet.complete).toBe(true);
    // Fifteen new launches push the old ones two pages down: pages 1 and 2 hold new coins, page 3
    // none, and the older coins (the rewarded one included) are kept without being read again.
    launches.unshift(
      ...Array.from({ length: 15 }, (_, i) => ({ ...launch(100 + i), rewardSymbol: "TSLAx" })),
    );
    h.asked.length = 0;
    const grown = await sweepOtcRoster(quiet.state, h.fetchImpl, T0 + 30 * 60_000);
    // (Pages go out one, then two at a time: page 4 rides along with page 3, where the read stops.)
    expect(h.asked).toEqual(["featured", "1", "2", "3", "4"]);
    const fees = feeDesksFromOtcRoster({ coins: grown.coins });
    expect(fees.get(filler(114))?.line).toBe("OTC Desks pays holder rewards in TSLAx.");
    expect(fees.get(filler(40))?.line).toBe("OTC Desks pays holder rewards in NVDAx.");
    expect(grown.complete).toBe(true);
  });

  it("keeps a partial full sweep and carries on from the page it missed", async () => {
    const launches = Array.from({ length: 60 }, (_, i) => launch(i));
    launches[30] = { ...launches[30]!, rewardSymbol: "NVDAx" };
    launches[55] = { ...launches[55]!, rewardSymbol: "TSLAx" };
    const h = host(launches);
    h.failing.add("3");
    const first = await sweepOtcRoster(null, h.fetchImpl, T0);
    expect(first.complete).toBe(false);
    expect(first.state.resume).toBe(3);
    const partial = feeDesksFromOtcRoster({ coins: first.coins });
    expect(partial.has(filler(30))).toBe(false);
    expect(partial.has(filler(55))).toBe(true);
    // The host answers again: the head stops at page 1, and the sweep reads from page 3 only.
    h.failing.clear();
    h.asked.length = 0;
    const next = await sweepOtcRoster(first.state, h.fetchImpl, T0 + 60_000);
    // Pages 3 to 10 go out as one batch, as in any sweep; page 2, already read, is not asked again.
    expect(h.asked.slice(0, 3)).toEqual(["featured", "1", "3"]);
    expect(h.asked).not.toContain("2");
    expect(next.complete).toBe(true);
    expect(next.state.resume).toBeNull();
    const fees = feeDesksFromOtcRoster({ coins: next.coins });
    expect(fees.has(filler(30))).toBe(true);
    expect(fees.has(filler(55))).toBe(true);
  });

  it("reads the head again after it missed a page, so a launch there is not skipped", async () => {
    const launches = Array.from({ length: 30 }, (_, i) => launch(i));
    const h = host(launches);
    const first = await sweepOtcRoster(null, h.fetchImpl, T0);
    launches.unshift(
      ...Array.from({ length: 20 }, (_, i) => ({ ...launch(200 + i), rewardSymbol: "TSLAx" })),
    );
    h.failing.add("2");
    const missed = await sweepOtcRoster(first.state, h.fetchImpl, T0 + 15 * 60_000);
    expect(missed.complete).toBe(false);
    expect(feeDesksFromOtcRoster({ coins: missed.coins }).has(filler(200))).toBe(true);
    expect(feeDesksFromOtcRoster({ coins: missed.coins }).has(filler(215))).toBe(false);
    h.failing.clear();
    const healed = await sweepOtcRoster(missed.state, h.fetchImpl, T0 + 16 * 60_000);
    expect(healed.complete).toBe(true);
    expect(feeDesksFromOtcRoster({ coins: healed.coins }).has(filler(215))).toBe(true);
  });

  it("reads the whole list again every six hours, for a basket changed on an older coin", async () => {
    const launches = Array.from({ length: 40 }, (_, i) => launch(i));
    const h = host(launches);
    let state: OtcRosterSweep = (await sweepOtcRoster(null, h.fetchImpl, T0)).state;
    launches[35] = { ...launches[35]!, rewardSymbol: "NVDAx" };
    const soon = await sweepOtcRoster(state, h.fetchImpl, T0 + 60 * 60_000);
    expect(feeDesksFromOtcRoster({ coins: soon.coins }).has(filler(35))).toBe(false);
    state = soon.state;
    const later = await sweepOtcRoster(state, h.fetchImpl, T0 + 6 * 60 * 60_000);
    expect(feeDesksFromOtcRoster({ coins: later.coins }).get(filler(35))?.line).toBe(
      "OTC Desks pays holder rewards in NVDAx.",
    );
    expect(later.complete).toBe(true);
  });
});

/** The gift tooltip, same joining as `creatorFeeLine` in the web fee badge. */
function feeTooltip(summary: string | null, deskLine: string | null): string | null {
  const sentence = (text: string | null): string | null => {
    const t = text?.trim().replace(/\.$/, "");
    return t ? `${t.charAt(0).toUpperCase()}${t.slice(1)}.` : null;
  };
  const lead = sentence(summary);
  const desk = sentence(deskLine);
  if (lead && desk && lead !== desk) return `${lead} ${desk}`;
  return lead ?? desk;
}

describe("creator fee wallet on an OTC coin", () => {
  it("names both stocks in the payload and tooltip instead of only the wallet sentence", async () => {
    const pump = filler(80);
    const wallet = MINT;
    const fetchImpl = async () =>
      json({
        coins: [
          { mint: wallet, rewardBasket: [NVDA, TSLA] },
          { mint: NVDA, symbol: "NVDAx" },
          { mint: TSLA, symbol: "TSLAx" },
        ],
      });
    const roster = await fetchOtcDeskRoster(fetchImpl as typeof fetch);
    const desk = resolveOtcDeskFee(pump, [wallet], roster);
    const payload = {
      destination: "wallet" as const,
      summary: "creator fees go to a wallet",
      deskLine: desk?.line ?? null,
      deskRewards: desk?.rewards ?? null,
    };
    const tooltip = feeTooltip(payload.summary, payload.deskLine);
    expect(payload.deskRewards).toEqual([
      { label: "NVDAx", mint: NVDA },
      { label: "TSLAx", mint: TSLA },
    ]);
    expect(tooltip).toBe("Creator fees go to a wallet. OTC Desks pays holder rewards in NVDAx and TSLAx.");
    expect(tooltip).not.toBe("Creator fees go to a wallet.");
    const flipped = `${wallet[0]!.toLowerCase()}${wallet.slice(1)}`;
    expect(resolveOtcDeskFee(pump, [flipped], roster)?.line).toBe(
      "OTC Desks pays holder rewards in NVDAx and TSLAx.",
    );
    const plain = feeTooltip(
      "creator fees go to a wallet",
      resolveOtcDeskFee(pump, [filler(81)], roster)?.line ?? null,
    );
    expect(plain).toBe("Creator fees go to a wallet.");
  });
});

describe("otcDeskFees", () => {
  it("does not call otcdesks.cash from the test runner", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network"));
    await expect(otcDeskFees([MINT], { wait: true })).resolves.toEqual(new Map());
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("keeps a matched OTC basket on the payload the web reads", async () => {
    const fetchImpl = async () =>
      new Response(
        JSON.stringify({
          coins: [
            { mint: MINT, rewardBasket: [NVDA, TSLA] },
            { mint: NVDA, symbol: "NVDAx" },
            { mint: TSLA, symbol: "TSLAx" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const desk = (await otcDeskFees([MINT], { wait: true, fetch: fetchImpl as typeof fetch })).get(MINT);
    const payload = {
      destination: "wallet" as const,
      summary: "creator fees go to a wallet",
      deskLine: desk?.line ?? null,
      deskRewards: desk?.rewards ?? null,
    };
    expect(payload.deskLine).toBe("OTC Desks pays holder rewards in NVDAx and TSLAx.");
    expect(payload.deskRewards).toEqual([
      { label: "NVDAx", mint: NVDA },
      { label: "TSLAx", mint: TSLA },
    ]);
  });
});

describe("otcDeskFeeForMint", () => {
  const OLD = "GHrjR2VJismiT4UpFY3FQH6LA64btVwVnGXW3KdUpump";

  it("asks the host about one coin past the sweep, and keeps the answer, a miss included", async () => {
    clearOtcDeskSingles();
    const asked: string[] = [];
    const fetchImpl = async (input: string | URL | Request) => {
      const url = new URL(String(input));
      asked.push(url.searchParams.get("mint") ?? "");
      if (url.searchParams.get("mint") === OLD)
        return json({ coins: [{ mint: OLD, rewardSymbol: "", rewardBasket: [NVDA, TSLA] }] });
      return json({ coins: [] });
    };
    const f = fetchImpl as typeof fetch;
    const now = 1_000_000;
    expect((await otcDeskFeeForMint(OLD, { fetch: f, now }))?.rewards.map((r) => r.mint)).toEqual([
      NVDA,
      TSLA,
    ]);
    expect(await otcDeskFeeForMint(MINT, { fetch: f, now })).toBeNull();
    // Both answers are kept: neither asks again within its window.
    expect(await otcDeskFeeForMint(OLD, { fetch: f, now: now + 60_000 })).not.toBeNull();
    expect(await otcDeskFeeForMint(MINT, { fetch: f, now: now + 20 * 60_000 })).toBeNull();
    expect(asked).toEqual([OLD, MINT]);
    // The miss is asked about again once its window has passed.
    await otcDeskFeeForMint(MINT, { fetch: f, now: now + 31 * 60_000 });
    expect(asked).toEqual([OLD, MINT, MINT]);
  });

  it("does not take another coin's row from a host that ignored the filter", async () => {
    clearOtcDeskSingles();
    const fetchImpl = async () => json({ coins: [{ mint: MINT, rewardSymbol: "NVDAx" }], total: 49_000 });
    expect(await otcDeskFeeForMint(OLD, { fetch: fetchImpl as typeof fetch, now: 1 })).toBeNull();
  });

  it("sends at most 30 lookups a minute", async () => {
    clearOtcDeskSingles();
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return json({ coins: [] });
    };
    const f = fetchImpl as typeof fetch;
    for (let i = 0; i < 40; i++) await otcDeskFeeForMint(filler(i), { fetch: f, now: 5_000 });
    expect(calls).toBe(30);
    await otcDeskFeeForMint(filler(39), { fetch: f, now: 65_000 });
    expect(calls).toBe(31);
  });

  it("adds a looked-up coin to the roster only for a path that holds for one coin", async () => {
    clearOtcDeskSingles();
    const fetchImpl = async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.searchParams.get("mint") === OLD)
        return json({ coins: [{ mint: OLD, rewardSymbol: "NVDAx" }] });
      return json({ coins: [{ mint: MINT, rewardSymbol: "TSLAx" }] });
    };
    const f = fetchImpl as typeof fetch;
    const held = await otcDeskRosterFor(OLD, { wait: true, fetch: f });
    expect(held.get(OLD)?.line).toBe("OTC Desks pays holder rewards in NVDAx.");
    expect(held.get(MINT)?.line).toBe("OTC Desks pays holder rewards in TSLAx.");
    expect((await otcDeskRosterFor(OLD, { fetch: f })).has(OLD)).toBe(false);
  });
});
