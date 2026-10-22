import { describe, expect, it, vi } from "vitest";
import { resolveOtcDeskFee } from "./feeDesks.js";
import { fetchOtcDeskRoster, otcDeskFees, otcRosterCacheMs } from "./otcDesk.js";

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
  it("does not treat a partial roster as a five-minute hit", () => {
    expect(otcRosterCacheMs({ complete: true, size: 4 })).toBe(5 * 60_000);
    expect(otcRosterCacheMs({ complete: false, size: 4 })).toBe(60_000);
    expect(otcRosterCacheMs({ complete: true, size: 0 })).toBe(60_000);
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
