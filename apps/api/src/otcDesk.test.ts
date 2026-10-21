import { describe, expect, it, vi } from "vitest";
import { fetchOtcDeskRoster, otcDeskFees } from "./otcDesk.js";

const MINT = "MukLDtJ8Cx9DxLbeyLRSWPSposTMWuwHANbuaudpump";
const NVDA = "So11111111111111111111111111111111111111112";
const TSLA = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

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
    const fetchImpl = async (input: RequestInfo | URL) => {
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
