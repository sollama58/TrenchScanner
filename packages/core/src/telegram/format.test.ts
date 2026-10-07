import { describe, expect, it } from "vitest";
import {
  ageText,
  escapeHtml,
  formatAlert,
  formatDigest,
  formatTestMessage,
  headline,
  type AlertCard,
} from "./format.js";

const token = {
  mintAddress: "Mint1111111111111111111111111111111111111111",
  symbol: "DOGE",
  name: "Doge <b>Coin</b>",
  firstSeenAt: new Date(Date.now() - 4 * 60_000),
};
const card = (over: Partial<AlertCard> = {}): AlertCard => ({
  token,
  snapshot: { marketCapUsd: 45_200, holderCount: 130, volume1hUsd: 22_000 },
  filters: [],
  calls: [],
  raisedAt: new Date(),
  ...over,
});
const links = { dashboardUrl: "https://trenchscanner.app/" };

describe("telegram alert text", () => {
  it("escapes everything that came from a token or a filter", () => {
    const text = formatAlert(card({ filters: [{ name: "<script>", score: 70 }] }), links);
    expect(text).not.toContain("<b>Coin</b>");
    expect(text).toContain("Doge &lt;b&gt;Coin&lt;/b&gt;");
    expect(text).toContain("“&lt;script&gt;”");
    expect(escapeHtml("a&b")).toBe("a&amp;b");
  });

  it("says who raised it", () => {
    expect(headline(card({ filters: [{ name: "Mine", score: 1 }] }))).toBe("caught by “Mine”");
    const call = {
      modelName: "Forest",
      confidence: 72,
      tier: "high",
      calibratedPct: 41,
      reasons: ["r1", "r2", "r3", "r4"],
      narrativeVerdict: "warns",
    };
    expect(headline(card({ calls: [call] }))).toBe("Forest called it");
    expect(headline(card({ calls: [call], filters: [{ name: "Mine", score: 1 }] }))).toBe(
      "Forest called it and your filter caught it",
    );
    const text = formatAlert(card({ calls: [call] }), links);
    expect(text).toContain("🟢 <b>$DOGE</b> — Forest called it");
    expect(text).toContain(
      "72% conviction · high conviction · 41% of calls like it 2x'd · ⚠️ Narrative warns",
    );
    expect(text).toContain("• r3");
    expect(text).not.toContain("• r4");
    expect(text).toContain("$45.2k mcap · 4m old · 130 holders · $22.0k vol 1h");
    expect(text).toContain(`<code>${token.mintAddress}</code>`);
    expect(text).toContain('<a href="https://trenchscanner.app/#live">TrenchScanner</a>');
    expect(text).toContain("https://axiom.trade/t/");
  });

  it("folds a burst into one digest", () => {
    const text = formatDigest(
      [
        card({ filters: [{ name: "A", score: 1 }] }),
        card({
          calls: [
            {
              modelName: "Rules",
              confidence: 50,
              tier: null,
              calibratedPct: null,
              reasons: [],
              narrativeVerdict: null,
            },
          ],
        }),
      ],
      links,
    );
    expect(text.startsWith("⚡ <b>2 new alerts</b>")).toBe(true);
    expect(text).toContain("Rules called it · $45.2k");
  });

  it("has a test message and an age formatter", () => {
    expect(formatTestMessage(links)).toContain("🔔");
    expect(ageText(new Date(Date.now() - 90 * 60_000), Date.now())).toBe("1h 30m old");
    expect(ageText(null, Date.now())).toBeNull();
  });
});
