import { describe, expect, it } from "vitest";
import { alertParts, alertStyle, formatAlert, formatDigest, type AlertCard } from "./format.js";
import {
  applySettingsPress,
  formatPreviewMessage,
  formatSettings,
  parseMcap,
  settingsKeyboard,
  type ChatSettings,
} from "./settings.js";
import { formatActiveAlerts, type ActiveAlert } from "./boards.js";

const defaults: ChatSettings = {
  hidden: [],
  layout: "full",
  links: ["terminal", "axiom", "gmgn"],
  alertsMinMcapUsd: 5_000,
};
const links = { dashboardUrl: "https://trenchscanner.app" };
const NOW = Date.parse("2026-10-10T23:00:00Z");

const card: AlertCard = {
  token: {
    mintAddress: "Mint1111111111111111111111111111111111111111",
    symbol: "DOGE",
    name: "Doge",
    firstSeenAt: new Date(NOW - 9 * 60_000),
    imageUrl: null,
  },
  snapshot: { marketCapUsd: 45_200, holderCount: 130, volume1hUsd: 22_000 },
  filters: [{ name: "Mine", score: 74 }],
  calls: [
    {
      modelName: "Atlas",
      confidence: 72,
      tier: "high",
      calibratedPct: 58,
      reasons: ["r1", "r2"],
      narrativeVerdict: null,
    },
  ],
  raisedAt: new Date(NOW),
};

describe("parseMcap", () => {
  it("reads the ways people write a market cap", () => {
    expect(parseMcap("10k")).toBe(10_000);
    expect(parseMcap("$25K")).toBe(25_000);
    expect(parseMcap("1.5m")).toBe(1_500_000);
    expect(parseMcap("250,000")).toBe(250_000);
    expect(parseMcap("off")).toBe(0);
    expect(parseMcap("lots")).toBeNull();
    expect(parseMcap("5b")).toBeNull();
  });
});

describe("the settings buttons", () => {
  it("toggles a part, a link, the layout and the floor, and ignores anything else", () => {
    const a = applySettingsPress(defaults, "st:p:holders");
    expect(a).toEqual({ kind: "change", settings: { ...defaults, hidden: ["holders"] } });
    const back = applySettingsPress({ ...defaults, hidden: ["holders"] }, "st:p:holders");
    expect(back?.kind === "change" && back.settings.hidden).toEqual([]);
    const k = applySettingsPress(defaults, "st:k:dexscreener");
    expect(k?.kind === "change" && k.settings.links).toEqual(["terminal", "axiom", "gmgn", "dexscreener"]);
    const off = applySettingsPress(defaults, "st:k:terminal");
    expect(off?.kind === "change" && off.settings.links).toEqual(["axiom", "gmgn"]);
    const lay = applySettingsPress(defaults, "st:lay:compact");
    expect(lay?.kind === "change" && lay.settings.layout).toBe("compact");
    const m = applySettingsPress(defaults, "st:m:25000");
    expect(m?.kind === "change" && m.settings.alertsMinMcapUsd).toBe(25_000);
    expect(applySettingsPress(defaults, "st:prev")).toEqual({ kind: "preview" });
    expect(applySettingsPress(defaults, "st:m:123")).toBeNull();
    expect(applySettingsPress(defaults, "st:p:bogus")).toBeNull();
    expect(applySettingsPress(defaults, "tb:6h")).toBeNull();
  });

  it("marks what is on and keeps every button's data inside Telegram's 64 bytes", () => {
    const kb = settingsKeyboard({ ...defaults, hidden: ["reasons"] }).inline_keyboard.flat();
    expect(kb.find((b) => b.callback_data === "st:p:reasons")?.text).toBe("▫️ Reasons");
    expect(kb.find((b) => b.callback_data === "st:p:image")?.text).toBe("✅ Picture");
    expect(kb.find((b) => b.callback_data === "st:lay:full")?.text).toBe("• Full •");
    expect(kb.find((b) => b.callback_data === "st:m:5000")?.text).toBe("• $5k •");
    expect(kb.every((b) => Buffer.byteLength(b.callback_data) <= 64)).toBe(true);
    const text = formatSettings({ ...defaults, hidden: ["reasons"] });
    expect(text).toContain("🙈 Hidden  Reasons");
    expect(text).toContain("🔗 Links  Terminal, Axiom, GMGN");
    expect(text).toContain("/alerts floor  <b>$5k</b>");
  });

  it("previews an alert in the chat's style", () => {
    const html = formatPreviewMessage({ ...defaults, layout: "compact" }, links, NOW).html;
    expect(html.startsWith("🔔 <b>$PREVIEW</b>")).toBe(true);
    expect(html).not.toContain("━");
  });
});

describe("alert style", () => {
  it("leaves the default card as it was", () => {
    expect(formatAlert(card, links, NOW)).toBe(formatAlert(card, links, NOW, undefined, alertStyle()));
  });

  it("switches holders, volume, age and the 2x rate on their own", () => {
    const parts = { ...alertStyleParts(), holders: false, age: false, calibrated: false };
    const html = formatAlert(card, links, NOW, parts);
    expect(html).toContain("MC <b>$45.2k</b>");
    expect(html).toContain("Vol 1h");
    expect(html).not.toContain("holders");
    expect(html).not.toContain("old");
    expect(html).not.toContain("like it 2x'd");
  });

  it("lays a compact card out in a few lines", () => {
    const html = formatAlert(card, links, NOW, undefined, alertStyle({ layout: "compact" }));
    expect(html.split("\n").slice(0, 4)).toEqual([
      "🟢 <b>$DOGE</b>  ·  <i>Atlas flagged it and your filter caught it</i>",
      "💰 MC <b>$45.2k</b>  ·  👥 <b>130</b> holders  ·  📊 Vol 1h <b>$22.0k</b>  ·  ⏱ 9m old",
      "🤖 <b>Atlas</b> <b>72%</b> 🔥  ·  58% like it 2x'd",
      "🎯 “Mine” <b>74</b>",
    ]);
    expect(html).not.toContain("blockquote");
    expect(html).not.toContain("━");
  });

  it("carries the links the chat picked, in menu order", () => {
    const html = formatAlert(card, links, NOW, undefined, alertStyle({ links: ["solscan", "dexscreener"] }));
    expect(html).toContain(
      '<a href="https://dexscreener.com/solana/Mint1111111111111111111111111111111111111111">DexScreener</a>  │  <a href="https://solscan.io/token/Mint1111111111111111111111111111111111111111">Solscan</a>',
    );
    expect(html).not.toContain("padre");
    const digest = formatDigest([card, card], links, undefined, alertStyle({ links: ["axiom"] }));
    expect(digest).toContain('href="https://axiom.trade/t/Mint');
    expect(formatAlert(card, links, NOW, undefined, alertStyle({ links: [] }))).not.toContain("│");
  });
});

describe("the /alerts floor", () => {
  const a = (symbol: string, nowMcapUsd: number | null, alertMcapUsd = 8_000): ActiveAlert => ({
    mintAddress: "Mint1111111111111111111111111111111111111111",
    symbol,
    name: null,
    sentAt: new Date(NOW - 60_000),
    source: { kind: "model", name: "Atlas" },
    alertMcapUsd,
    nowMcapUsd,
    peakPct: null,
    status: "watching",
    hit2x: false,
    minutesLeft: 5,
  });

  it("leaves out alerts under it, judged on the market cap now, and says how many", () => {
    const html = formatActiveAlerts([a("BIG", 40_000), a("TINY", 3_000), a("NOREAD", null)], links, NOW, {
      minMcapUsd: 5_000,
    });
    expect(html).toContain("2 tracking");
    expect(html).toContain("$BIG");
    expect(html).toContain("$NOREAD");
    expect(html).not.toContain("$TINY");
    expect(html).toContain("1 under $5k market cap not shown");
    expect(formatActiveAlerts([a("TINY", 3_000)], links, NOW, { minMcapUsd: 0 })).toContain("$TINY");
  });
});

function alertStyleParts() {
  return alertParts();
}
