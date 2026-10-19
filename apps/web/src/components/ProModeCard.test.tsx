import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ProModeCard } from "./ProModeCard";
import type { WalletBalance } from "../walletBalance";

const funds = (
  holder: { rank: number | null; [k: string]: unknown },
  totalRaw = "5000000000",
): WalletBalance => ({
  balance: {
    mint: "mint",
    decimals: 6,
    tokenProgram: "prog",
    totalRaw,
    solLamports: "1000000000",
    holder: { of: 250, scannedAt: new Date().toISOString(), stale: false, ...holder },
    proOpen: true,
    accounts: [],
  },
  error: null,
  at: Date.now(),
  reload: () => {},
});

describe("Settings' Pro Mode card", () => {
  it("counts down a qualifying holder's hour", () => {
    const html = renderToStaticMarkup(
      <ProModeCard
        funds={funds({ rank: 12, qualifiesAt: new Date(Date.now() + 40 * 60_000).toISOString() })}
        onBuy={null}
      />,
    );
    expect(html).toMatch(/In (40|39) min/);
    expect(html).toContain("#12 of the top 250");
  });

  it("says what #250 holds and how much more it takes, with what Pro Mode unlocks", () => {
    const html = renderToStaticMarkup(
      <ProModeCard funds={funds({ rank: null, cutoffRaw: "1250000000000" })} onBuy={() => {}} />,
    );
    expect(html).toContain("Not yet");
    // 1.25M held at #250, 5,000 held here.
    expect(html).toContain("1.25M $ASDFASDFA");
    expect(html).toContain("1.25M</strong> more");
    expect(html).toContain("Buy $ASDFASDFA");
    expect(html).toContain("Trade in the coin window");
  });
});
