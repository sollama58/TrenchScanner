import { afterEach, describe, expect, it } from "vitest";
import {
  clearStonkLaunchFees,
  keptStonkLaunchFee,
  stonkCardFee,
  stonkFeeSummary,
  stonkLaunchFeeFromBody,
  stonkLaunchFees,
} from "./stonkLaunch.js";

const MINT = "8PQxd6VmfGPMyg8WPnfkT9jUTmtE7UsnDmvBKXeAVP9z";
const OTHER = "CYoJ4CC1oGt1Hk1y2XZQ9aDJHsh7kZSFSHMWvChAgyxC";
const SPYX = "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W";
const CREATOR = "JCZBhPewgvoAYHCmirP3vvXe3VpXiXVY1gSsj1o2ZsCw";

const reward = {
  data: {
    token: {
      mode: "reward",
      quote: { mint: SPYX, symbol: "SPYx" },
      transferFee: { bps: 300 },
      communityMode: { shareBps: 2000 },
    },
    launch: { creator: CREATOR, mode: "reward" },
  },
};
const standard = { data: { token: { mode: "standard", creator: CREATOR }, launch: { creator: CREATOR } } };

afterEach(() => clearStonkLaunchFees());

describe("stonkLaunchFeeFromBody", () => {
  it("reads a reward launch's tax, reward coin and community share", () => {
    expect(stonkLaunchFeeFromBody(reward)).toEqual({
      mode: "reward",
      taxBps: 300,
      reward: { label: "SPYx", mint: SPYX },
      creator: CREATOR,
      creatorShareBps: null,
      communityShareBps: 2000,
    });
  });

  it("reads a standardV2 launch's creator share and a standard launch as the dev's", () => {
    const v2 = stonkLaunchFeeFromBody({
      data: {
        token: {
          mode: "standardV2",
          quote: { mint: SPYX },
          transferFee: { bps: 100 },
          feeRecipients: { shareBps: 5000 },
        },
      },
    });
    expect(v2).toMatchObject({ mode: "standardV2", taxBps: 100, creatorShareBps: 5000 });
    expect(v2?.reward?.label).toBe("XsoC…DF2W");
    expect(stonkLaunchFeeFromBody(standard)).toMatchObject({
      mode: "standard",
      taxBps: null,
      reward: null,
      creator: CREATOR,
    });
  });

  it("is null for anything that is not a token answer", () => {
    expect(stonkLaunchFeeFromBody({ error: { code: "not_found" } })).toBeNull();
    expect(stonkLaunchFeeFromBody({ data: { token: { mode: "other" } } })).toBeNull();
    expect(stonkLaunchFeeFromBody(null)).toBeNull();
  });
});

describe("stonkCardFee", () => {
  it("makes a reward launch a holder-rewards coin that Stonk pays, in its quote coin", () => {
    expect(stonkCardFee(stonkLaunchFeeFromBody(reward)!)).toEqual({
      destination: "holder_rewards",
      summary: "a 3% transfer tax pays holders; 20% of each payout goes to the quote coin's holders",
      bps: 300,
      recipients: null,
      deskLine: "Stonk pays holder rewards in SPYx.",
      deskRewards: [{ label: "SPYx", mint: SPYX }],
      rewardHost: "Stonk",
    });
  });

  it("makes a standard launch a dev-fee coin naming the creator wallet when it is known", () => {
    const fee = stonkLaunchFeeFromBody(standard)!;
    expect(stonkCardFee(fee, { name: "Cupsey", avatar: "/api/kol/cupsey.jpg", kol: true })).toMatchObject({
      destination: "creator",
      summary: "creator fees go to the dev, Cupsey (JCZB…ZsCw)",
      recipients: [
        { label: "JCZB…ZsCw", bps: null, name: "Cupsey", avatar: "/api/kol/cupsey.jpg", kol: true },
      ],
    });
    expect(stonkCardFee(fee).summary).toBe("creator fees go to the dev, JCZB…ZsCw");
    expect(stonkFeeSummary({ ...fee, creator: null }, null)).toBe("creator fees go to the dev");
  });
});

describe("stonkLaunchFees", () => {
  it("reads each coin once, keeps a 404 as not a Stonk pool, and does not keep a failure", async () => {
    const asked: string[] = [];
    const fetchStub = (async (url: string) => {
      const mint = url.split("/").pop()!;
      asked.push(mint);
      if (mint === MINT) return new Response(JSON.stringify(reward), { status: 200 });
      if (mint === OTHER)
        return new Response(JSON.stringify({ error: { code: "not_found" } }), { status: 404 });
      return new Response("busy", { status: 503 });
    }) as unknown as typeof fetch;
    const first = await stonkLaunchFees([MINT, OTHER, CREATOR, "nope"], { wait: true, fetch: fetchStub });
    expect([...first.keys()]).toEqual([MINT]);
    expect(keptStonkLaunchFee(OTHER)).toBeNull();
    expect(keptStonkLaunchFee(CREATOR)).toBeUndefined();
    const second = await stonkLaunchFees([MINT, OTHER, CREATOR], { wait: true, fetch: fetchStub });
    expect(second.get(MINT)?.mode).toBe("reward");
    expect(asked.sort()).toEqual([CREATOR, CREATOR, MINT, OTHER].sort());
  });

  it("answers a feed from what is kept and reads the rest behind it", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const fetchStub = (async () => {
      await gate;
      return new Response(JSON.stringify(standard), { status: 200 });
    }) as unknown as typeof fetch;
    expect((await stonkLaunchFees([MINT], { fetch: fetchStub })).size).toBe(0);
    release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(keptStonkLaunchFee(MINT)?.mode).toBe("standard");
  });
});
