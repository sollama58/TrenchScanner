import { describe, expect, it } from "vitest";
import {
  ageText,
  alertImage,
  alertMessage,
  cardRank,
  digestMessage,
  escapeHtml,
  formatAlert,
  formatDigest,
  formatTestMessage,
  headline,
  sortCards,
  type AlertCard,
} from "./format.js";

const token = {
  mintAddress: "Mint1111111111111111111111111111111111111111",
  symbol: "DOGE",
  name: "Doge <b>Coin</b>",
  firstSeenAt: new Date(Date.now() - 4 * 60_000),
  imageUrl: "https://cdn.example/doge.png",
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
    expect(text).toContain("🟢 <b>$DOGE</b> · Doge &lt;b&gt;Coin&lt;/b&gt;\n<i>Forest called it</i>");
    expect(text).toContain(
      "🤖 <b>Forest</b> · 72% conviction · 🔥 high conviction · 41% of calls like it 2x'd · ⚠️ Narrative warns",
    );
    expect(text).toContain("<blockquote>• r1\n• r2\n• r3</blockquote>");
    expect(text).not.toContain("• r4");
    expect(text).toContain("💰 $45.2k mcap  ·  👥 130 holders  ·  📊 $22.0k vol 1h  ·  ⏱ 4m old");
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
    expect(text.startsWith("⚡ <b>2 new alerts</b> · strongest first")).toBe(true);
    // The model call outranks the filter-only match, so it is line 1.
    expect(text).toContain("1. 🟢 <b>$DOGE</b> · Rules 50% · $45.2k");
    expect(text).toContain("2. 🎯 <b>$DOGE</b> · “A” score 1 · $45.2k");
    expect(text).toContain('<a href="https://trade.padre.gg/trade/solana/');
  });

  it("ranks the strongest card first and the strongest call first inside a card", () => {
    const call = (modelName: string, confidence: number, tier: string | null = null) => ({
      modelName,
      confidence,
      tier,
      calibratedPct: null,
      reasons: [],
      narrativeVerdict: null,
    });
    const weakCall = card({ calls: [call("Rules", 40)] });
    const strongCall = card({ calls: [call("Forest", 55, "high")] });
    const bigFilter = card({ filters: [{ name: "Big", score: 99 }] });
    expect(cardRank(strongCall)).toBeGreaterThan(cardRank(weakCall));
    expect(cardRank(weakCall)).toBeGreaterThan(cardRank(bigFilter));
    expect(sortCards([bigFilter, weakCall, strongCall]).map((c) => headline(c))).toEqual([
      "Forest called it",
      "Rules called it",
      "caught by “Big”",
    ]);
    const text = formatAlert(
      card({
        calls: [call("Rules", 40), call("Forest", 70)],
        filters: [
          { name: "Low", score: 20 },
          { name: "High", score: 90 },
        ],
      }),
      links,
    );
    expect(text.indexOf("<b>Forest</b>")).toBeLessThan(text.indexOf("<b>Rules</b>"));
    expect(text.indexOf("“High”")).toBeLessThan(text.indexOf("“Low”"));
  });

  it("pictures a message with the token's logo only when it is an https URL", () => {
    expect(alertMessage(card(), links).imageUrl).toBe("https://cdn.example/doge.png");
    expect(alertImage({ imageUrl: "http://plain.example/x.png" })).toBeNull();
    expect(alertImage({ imageUrl: "  " })).toBeNull();
    expect(alertImage({ imageUrl: null })).toBeNull();
    const noArt = card({ token: { ...token, imageUrl: null } });
    const withArt = card({
      token: { ...token, imageUrl: "https://cdn.example/top.png" },
      calls: [
        {
          modelName: "F",
          confidence: 80,
          tier: null,
          calibratedPct: null,
          reasons: [],
          narrativeVerdict: null,
        },
      ],
    });
    // The digest wears the strongest pictured token's logo.
    expect(digestMessage([noArt, withArt], links).imageUrl).toBe("https://cdn.example/top.png");
    expect(digestMessage([noArt], links).imageUrl).toBeNull();
  });

  it("has a test message and an age formatter", () => {
    const test = formatTestMessage(links);
    expect(test.html).toContain("🔔 <b>$TEST</b>");
    expect(test.imageUrl).toBe("https://trenchscanner.app/icon-512.png");
    expect(formatTestMessage({ dashboardUrl: "http://localhost:5173" }).imageUrl).toBeNull();
    expect(ageText(new Date(Date.now() - 90 * 60_000), Date.now())).toBe("1h 30m old");
    expect(ageText(null, Date.now())).toBeNull();
  });
});
