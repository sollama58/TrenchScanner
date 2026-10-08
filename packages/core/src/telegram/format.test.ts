import { describe, expect, it } from "vitest";
import {
  ageText,
  alertImage,
  alertMessage,
  alertParts,
  CAPTION_MAX_CHARS,
  captionLength,
  cardRank,
  convictionBar,
  DIGEST_MAX_ENTRIES,
  digestMessage,
  escapeHtml,
  formatAlert,
  formatDigest,
  formatTestMessage,
  headline,
  sageUrl,
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
    expect(text).toContain("<b>“&lt;script&gt;”</b>");
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
    expect(text).toContain(
      "🟢 <b>$DOGE</b>  ·  Doge &lt;b&gt;Coin&lt;/b&gt;\n<i>Forest called it</i>\n━━━━━━━━━━━━━━\n💰 MC",
    );
    expect(text).toContain(
      "🤖 <b>Forest</b>  ▰▰▰▰▰▰▰▱▱▱  <b>72%</b> conviction  🔥 high\n" +
        "     📈 41% of calls like it 2x'd\n" +
        "     ⚠️ Narrative warns\n" +
        "<blockquote>▸ r1\n▸ r2\n▸ r3</blockquote>",
    );
    expect(text).not.toContain("▸ r4");
    expect(text).toContain(
      "💰 MC <b>$45.2k</b>   ·   👥 <b>130</b> holders\n📊 Vol 1h <b>$22.0k</b>   ·   ⏱ 4m old",
    );
    expect(text).toContain(`📋 <code>${token.mintAddress}</code>`);
    expect(text).toContain('🔭 <a href="https://trenchscanner.app/#live">TrenchScanner</a>');
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
    expect(text.startsWith("⚡ <b>2 new alerts</b>  ·  strongest first\n━━━━━━━━━━━━━━")).toBe(true);
    // The model call outranks the filter-only match, so it is line 1.
    expect(text).toContain("🥇 🟢 <b>$DOGE</b> · Rules 50% · $45.2k");
    expect(text).toContain("🥈 🎯 <b>$DOGE</b> · “A” score 1 · $45.2k");
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
    // An IPFS file on any public gateway is read through the Pinata resizer instead.
    const cid = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";
    const resized = `https://pump.mypinata.cloud/ipfs/${cid}?img-width=640&img-height=640&img-fit=scale-down&img-format=jpeg`;
    expect(alertImage({ imageUrl: `https://ipfs.io/ipfs/${cid}` })).toBe(resized);
    expect(alertImage({ imageUrl: `https://${cid}.ipfs.nftstorage.link/` })).toBe(resized);
    expect(alertImage({ imageUrl: `https://cf-ipfs.com/ipfs/${cid}?x=1` })).toBe(resized);
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

  it("leaves out the parts a chat switched off", () => {
    const call = {
      modelName: "Forest",
      confidence: 72,
      tier: null,
      calibratedPct: null,
      reasons: ["r1"],
      narrativeVerdict: null,
    };
    const full = card({ calls: [call], filters: [{ name: "Mine", score: 70 }] });
    const parts = alertParts(["image", "stats", "reasons", "mint", "links", "sage", "bogus"]);
    expect(parts).toMatchObject({
      image: false,
      stats: false,
      reasons: false,
      conviction: true,
      filters: true,
    });
    const text = formatAlert(full, links, Date.now(), parts);
    expect(text).toContain("🤖 <b>Forest</b>  ▰▰▰▰▰▰▰▱▱▱  <b>72%</b> conviction");
    expect(text).toContain("🎯 <b>“Mine”</b>  ·  score <b>70</b>");
    expect(text).not.toContain("blockquote");
    expect(text).not.toContain("mcap");
    expect(text).not.toContain("<code>");
    expect(text).not.toContain("<a href");
    expect(alertMessage(full, links, Date.now(), parts).imageUrl).toBeNull();
    // Reasons without the conviction line: just the quote.
    const quoteOnly = formatAlert(full, links, Date.now(), alertParts(["conviction"]));
    expect(quoteOnly).toContain("<blockquote>▸ r1</blockquote>");
    expect(quoteOnly).not.toContain("conviction");
    const digest = formatDigest([full], links, alertParts(["links", "stats", "sage"]));
    expect(digest).not.toContain("trade ↗</a>");
    expect(digest).toContain(`<code>${token.mintAddress}</code>`);
    expect(formatTestMessage(links, alertParts(["image"])).imageUrl).toBeNull();
  });

  it("links to the token's TokenSage view on the dashboard", () => {
    const url = `https://trenchscanner.app/?sage=${token.mintAddress}`;
    expect(sageUrl(token.mintAddress, links)).toBe(url);
    expect(sageUrl(token.mintAddress, { dashboardUrl: "" })).toBeNull();
    expect(formatAlert(card(), links)).toContain(`🔮 <a href="${url}">TokenSage read</a>`);
    expect(formatAlert(card(), links, Date.now(), alertParts(["sage"]))).not.toContain("?sage=");
    expect(formatAlert(card(), { dashboardUrl: "" })).not.toContain("TokenSage");
    // A digest stays short enough to keep its picture: its lines carry no per-token read link.
    expect(formatDigest([card()], links)).not.toContain("?sage=");
  });

  it("keeps a crowded alert and a full digest inside a photo caption", () => {
    const call = (modelName: string, confidence: number) => ({
      modelName,
      confidence,
      tier: "high",
      calibratedPct: 46,
      reasons: [
        "a reason about as long as the models usually write one, give or take",
        "x".repeat(60),
        "y".repeat(60),
      ],
      narrativeVerdict: "agrees",
    });
    const crowded = card({
      token: { ...token, symbol: "WOJAKMAXXING", name: "Wojak Maxxing The Trenches Forever" },
      calls: [call("Forest", 81), call("Rules", 64), call("Boost", 58)],
      filters: [
        { name: "Fresh launches under 100k with volume", score: 88 },
        { name: "Low snipers", score: 74 },
      ],
    });
    expect(captionLength(formatAlert(crowded, links))).toBeLessThanOrEqual(CAPTION_MAX_CHARS);
    const burst = Array.from({ length: DIGEST_MAX_ENTRIES + 3 }, (_, i) =>
      card({ token: { ...token, symbol: `TOKEN${i}` }, calls: [call("Forest", 70 - i), call("Rules", 50)] }),
    );
    expect(captionLength(formatDigest(burst, links))).toBeLessThanOrEqual(CAPTION_MAX_CHARS);
    expect(convictionBar(72)).toBe("▰▰▰▰▰▰▰▱▱▱");
    expect(convictionBar(140)).toBe("▰▰▰▰▰▰▰▰▰▰");
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
