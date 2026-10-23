// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "./bootstrap-env.js";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@trenchscanner/core";
import { creatorFeesByMint } from "./curatedFeed.js";
import { clearStonkLaunchFees, stonkLaunchFees } from "./stonkLaunch.js";

/** A Stonks coin's card fee comes from StonkFun's answer, kept per mint (user ask 2026-10-23). */
const REWARD = "StonkRewardFeeMint1111111111111111111111111";
const DEV = "StonkDevFeeMint11111111111111111111111111111";
const QUOTE = "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W";
const CREATOR = "JCZBhPewgvoAYHCmirP3vvXe3VpXiXVY1gSsj1o2ZsCw";
const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

describe.skipIf(!dbAvailable)("creatorFeesByMint on Stonks coins", () => {
  afterAll(async () => {
    clearStonkLaunchFees();
    await prisma.token.deleteMany({ where: { mintAddress: { in: [REWARD, DEV] } } });
  });

  it("marks a reward launch as Stonk holder rewards and a standard launch as the dev's", async () => {
    await prisma.token.deleteMany({ where: { mintAddress: { in: [REWARD, DEV] } } });
    await prisma.token.createMany({
      data: [
        { mintAddress: REWARD, launchpad: "stonks" },
        { mintAddress: DEV, launchpad: "stonks" },
      ],
    });
    const body = (mint: string) =>
      mint === REWARD
        ? {
            data: {
              token: { mode: "reward", quote: { mint: QUOTE, symbol: "SPYx" }, transferFee: { bps: 300 } },
            },
          }
        : { data: { token: { mode: "standard", creator: CREATOR } } };
    await stonkLaunchFees([REWARD, DEV], {
      wait: true,
      fetch: (async (url: string) =>
        new Response(JSON.stringify(body(url.split("/").pop()!)), {
          status: 200,
        })) as unknown as typeof fetch,
    });
    const fees = await creatorFeesByMint([REWARD, DEV]);
    expect(fees.get(REWARD)).toMatchObject({
      destination: "holder_rewards",
      bps: 300,
      deskLine: "Stonk pays holder rewards in SPYx.",
      rewardHost: "Stonk",
    });
    expect(fees.get(REWARD)?.deskRewards?.[0]).toMatchObject({ label: "SPYx", mint: QUOTE });
    expect(fees.get(DEV)).toMatchObject({
      destination: "creator",
      summary: "creator fees go to the dev, JCZB…ZsCw",
      recipients: [{ label: "JCZB…ZsCw", bps: null }],
    });
  });
});
