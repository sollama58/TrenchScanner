import { describe, expect, it } from "vitest";
import type { AlertNow } from "./boards.js";
import { ALL_PARTS, CAPTION_MAX_CHARS, DEFAULT_STYLE, captionLength, type AlertCard } from "./format.js";
import {
  REFRESH_COOLDOWN_MS,
  formatRefreshedAlert,
  parseRefreshCallback,
  readStoredCard,
  refreshCallbackData,
  refreshKeyboard,
  refreshWaitSeconds,
  storedCard,
} from "./refresh.js";

const token = {
  mintAddress: "Mint1111111111111111111111111111111111pump",
  symbol: "DOG",
  name: "Dog",
  firstSeenAt: new Date("2026-10-23T22:00:00Z"),
  imageUrl: null,
};
const card: AlertCard = {
  token,
  snapshot: {
    marketCapUsd: 40_000,
    holderCount: 120,
    holderCountAt: new Date("2026-10-23T22:29:00Z"),
    volume1hUsd: 9_000,
  },
  filters: [{ name: "Mine", score: 71 }],
  calls: [
    {
      modelName: "Rules",
      confidence: 80,
      tier: "high",
      calibratedPct: 41,
      reasons: ["fresh wallets", "volume up"],
      narrativeVerdict: null,
    },
  ],
  raisedAt: new Date("2026-10-23T22:30:00Z"),
};
const fresh: AlertNow = {
  token: { ...token, name: "Dog Coin" },
  holderCount: 300,
  holderCountAt: new Date("2026-10-23T22:44:00Z"),
  volume1hUsd: 52_000,
  alertMcapUsd: 40_000,
  nowMcapUsd: 60_000,
  peakPct: 110,
};
const NOW = new Date("2026-10-23T22:45:07Z").getTime();

describe("refresh callback data", () => {
  it("names a send and reads back the same one, inside Telegram's 64 bytes", () => {
    const sentAt = new Date("2026-10-23T22:30:01.234Z");
    const data = refreshCallbackData("cmh3k2x9a0000abcdefghijkl", sentAt)!;
    expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
    expect(parseRefreshCallback(data)).toEqual({ tokenId: "cmh3k2x9a0000abcdefghijkl", sentAt });
    expect(refreshKeyboard("cmh3k2x9a0000abcdefghijkl", sentAt)!.inline_keyboard[0]![0]).toEqual({
      text: "🔄 Refresh",
      callback_data: data,
    });
  });

  it("refuses anything else", () => {
    for (const bad of [
      "",
      "rf:",
      "rf:abc",
      "rf:abc:",
      "rf:abc:ZZ",
      "rf:a b:1",
      "rf:abc:1:2",
      `rf:${"a".repeat(41)}:1`,
      "rf:abc:0",
      "rf:abc:zzzzzzzzzzz",
      "tb:6h",
    ])
      expect(parseRefreshCallback(bad), bad).toBeNull();
    expect(refreshCallbackData("has space", new Date())).toBeNull();
  });

  it("says how long until the next press", () => {
    const at = new Date(NOW - 6_000);
    expect(refreshWaitSeconds(at, NOW)).toBe(Math.ceil((REFRESH_COOLDOWN_MS - 6_000) / 1_000));
    expect(refreshWaitSeconds(at, NOW + 60_000)).toBe(1);
  });
});

describe("stored card", () => {
  it("round-trips through JSON around the token's row now", () => {
    const json = JSON.parse(JSON.stringify(storedCard(card)));
    expect(readStoredCard(json, fresh.token)).toEqual({ ...card, token: fresh.token });
  });

  it("refuses a missing or malformed card", () => {
    const json = JSON.parse(JSON.stringify(storedCard(card)));
    expect(readStoredCard(null, token)).toBeNull();
    expect(readStoredCard("x", token)).toBeNull();
    expect(readStoredCard({ ...json, v: 2 }, token)).toBeNull();
    expect(readStoredCard({ ...json, raisedAt: "never" }, token)).toBeNull();
    expect(readStoredCard({ ...json, calls: [{ modelName: 5 }] }, token)).toBeNull();
    expect(readStoredCard({ ...json, snapshot: { marketCapUsd: "40k" } }, token)).toBeNull();
    expect(readStoredCard({ ...json, filters: [], calls: [] }, token)).toBeNull();
  });
});

describe("formatRefreshedAlert", () => {
  it("shows the market now and the peak beside the alert's, with fresh holders and volume", () => {
    const html = formatRefreshedAlert(
      card,
      fresh,
      { dashboardUrl: "" },
      NOW,
      ALL_PARTS,
      DEFAULT_STYLE,
      false,
    );
    expect(html).toContain("💰 MC <b>$40.0k</b> at alert");
    expect(html).toContain("📈 Now <b>$60.0k</b> +50%");
    expect(html).toContain("🏔 Peak <b>+110% (2.1x)</b>");
    expect(html).toContain("👥 <b>300</b> holders");
    expect(html).not.toContain("read 1m ago");
    expect(html).toContain("📊 Vol 1h <b>$52.0k</b>");
    expect(html).toContain("Dog Coin");
    expect(html).toContain("🤖 <b>Rules</b>");
    expect(html).toContain("▸ fresh wallets");
    expect(html).toContain("🔄 <i>Refreshed 22:45:07 UTC</i>");
  });

  it("says when there is no fresh reading, and keeps the card's numbers where none are newer", () => {
    const html = formatRefreshedAlert(
      card,
      {
        ...fresh,
        nowMcapUsd: null,
        peakPct: null,
        holderCount: null,
        holderCountAt: null,
        volume1hUsd: null,
      },
      { dashboardUrl: "" },
      NOW,
      ALL_PARTS,
      DEFAULT_STYLE,
      false,
    );
    expect(html).toContain("📈 Now <i>no fresh reading</i>");
    expect(html).not.toContain("Peak");
    expect(html).toContain("👥 <b>120</b> holders, read 16m ago");
    expect(html).toContain("📊 Vol 1h <b>$9.0k</b>");
  });

  it("keeps a photo's caption inside Telegram's cap", () => {
    const long = {
      ...card,
      calls: [{ ...card.calls[0]!, reasons: ["r".repeat(300), "s".repeat(300), "t".repeat(300)] }],
    };
    const asText = formatRefreshedAlert(
      long,
      fresh,
      { dashboardUrl: "" },
      NOW,
      ALL_PARTS,
      DEFAULT_STYLE,
      false,
    );
    expect(captionLength(asText)).toBeGreaterThan(CAPTION_MAX_CHARS);
    const asCaption = formatRefreshedAlert(
      long,
      fresh,
      { dashboardUrl: "" },
      NOW,
      ALL_PARTS,
      DEFAULT_STYLE,
      true,
    );
    expect(captionLength(asCaption)).toBeLessThanOrEqual(CAPTION_MAX_CHARS);
    expect(asCaption).toContain("📈 Now");
  });
});
