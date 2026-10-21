import { describe, expect, it } from "vitest";
import { fetchOtcDeskRoster } from "./otcDesk.js";

const MINT = "MukLDtJ8Cx9DxLbeyLRSWPSposTMWuwHANbuaudpump";

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
      [MINT, "OTC Desks pays holder rewards in NVDAx."],
    ]);
  });

  it("shows nothing when the roster does not answer", async () => {
    const fetchImpl = async () => new Response("no", { status: 503 });
    expect((await fetchOtcDeskRoster(fetchImpl as typeof fetch)).size).toBe(0);
  });
});
