// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnv, prisma, type Env } from "@trenchscanner/core";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../server.js";
import { createSessionSigner, SESSION_COOKIE_NAME } from "../auth/session.js";
import { resetContestStateCache } from "../contest.js";
import { DEFAULT_ALERT_PREFS, parseAlertPrefs } from "../alertPrefs.js";
import {
  DEFAULT_FEED_APPEARANCE,
  feedAppearanceSchema,
  parseFeedAppearance,
  storedAppearanceKeys,
} from "../feedAppearance.js";
import { DEFAULT_HIDDEN_TOKENS, MAX_HIDDEN_TOKENS, parseHiddenTokens } from "../hiddenTokens.js";
import { parseUserPrefs } from "../userPrefs.js";

/** The Settings tab's API: alert settings, access, and following the best performer. */

const WALLET = "SettingsTestWa11et111111111111111111111111";
const ADMIN_WALLET = "SettingsTestAdmin11111111111111111111111111";
const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

describe("parseAlertPrefs", () => {
  it("fills missing or bad fields with the defaults", () => {
    expect(parseAlertPrefs(null)).toEqual(DEFAULT_ALERT_PREFS);
    expect(parseAlertPrefs({ sound: "foghorn", volume: 300, notifyOn: { modelCalls: false } })).toEqual({
      ...DEFAULT_ALERT_PREFS,
      notifyOn: { filterMatches: true, modelCalls: false },
    });
  });
});

describe("parseFeedAppearance", () => {
  it("fills missing or bad fields with the defaults and drops unknown card fields", () => {
    expect(parseFeedAppearance(null)).toEqual(DEFAULT_FEED_APPEARANCE);
    expect(parseFeedAppearance({}).cardSearch).toBe(true);
    expect(parseFeedAppearance({ cardSearch: false }).cardSearch).toBe(false);
    expect(
      parseFeedAppearance({
        theme: "neon",
        win: "#00FF88",
        loss: "red",
        columns: 9,
        textSize: 110,
        hidden: ["reasons", "sparkles", "reasons", 4],
      }),
    ).toEqual({ ...DEFAULT_FEED_APPEARANCE, win: "#00ff88", textSize: 110, hidden: ["reasons"] });
  });

  it("hides model reasons and links only Terminal for accounts saved before those options", () => {
    const saved = parseFeedAppearance({
      ...DEFAULT_FEED_APPEARANCE,
      reasons: undefined,
      quickLinks: undefined,
    });
    expect(saved.reasons).toBe(false);
    expect(saved.quickLinks).toEqual(["terminal"]);
    // The Snipers tile is off by default (Block 0 in its place). A look saved on before that reads
    // off; one switched on since stays on.
    expect(saved.sniperTop10).toBe(false);
    expect(DEFAULT_FEED_APPEARANCE.sniperTop10).toBe(false);
    expect(parseFeedAppearance({ sniperTop10: true }).sniperTop10).toBe(false);
    expect(parseFeedAppearance({ sniperTop10: true, sniperTop10Rev: 2 }).sniperTop10).toBe(true);
    expect(parseFeedAppearance({ sniperTop10: false }).sniperTop10).toBe(false);
    // CEX-funded took the Dev tile's default place: Dev is opt-in, for older accounts too, and the
    // old CEX-funded switch is ignored.
    expect(DEFAULT_FEED_APPEARANCE.devTile).toBe(false);
    expect(parseFeedAppearance({ cexFunded: false }).devTile).toBe(false);
    expect(parseFeedAppearance({ devTile: true }).devTile).toBe(true);
    // The Stream tab is opt-in, and an account saved before it has it off.
    expect(DEFAULT_FEED_APPEARANCE.streamTab).toBe(false);
    expect(parseFeedAppearance({}).streamTab).toBe(false);
    expect(parseFeedAppearance({ streamTab: true }).streamTab).toBe(true);
    // The Lighthouse tab shows unless switched off, whatever the retired opt-in switch saved.
    expect(DEFAULT_FEED_APPEARANCE.hideLighthouseTab).toBe(false);
    expect(parseFeedAppearance({}).hideLighthouseTab).toBe(false);
    expect(parseFeedAppearance({ lighthouseTab: false }).hideLighthouseTab).toBe(false);
    expect(parseFeedAppearance({ hideLighthouseTab: true }).hideLighthouseTab).toBe(true);
    // The token view's safety pill shows unless switched off.
    expect(parseFeedAppearance({}).hideSafetyPill).toBe(false);
    expect(parseFeedAppearance({ hideSafetyPill: true }).hideSafetyPill).toBe(true);
    // The token window opens in Pro on desktop unless Classic is picked (user ask 2026-10-19).
    expect(parseFeedAppearance({}).tokenView).toBe("pro");
    expect(parseFeedAppearance({ tokenView: "classic" }).tokenView).toBe("classic");
    expect(parseFeedAppearance({ tokenView: "terminal" }).tokenView).toBe("pro");
    expect(parseFeedAppearance({ lighthouseTab: false })).not.toHaveProperty("lighthouseTab");
    expect(
      parseFeedAppearance({ reasons: true, quickLinks: ["gmgn", "padre", "gmgn", "axiom"] }),
    ).toMatchObject({
      reasons: true,
      quickLinks: ["gmgn", "axiom"],
    });
    expect(parseFeedAppearance({ quickLinks: [] }).quickLinks).toEqual([]);
    // The token chart's labeled-wallet trades: every kind but risky wallets at 0.5 SOL, never under 0.25 SOL.
    expect(parseFeedAppearance({})).toMatchObject({ chartMarks: true, chartMarkMinSol: 0.5 });
    // KOLs' marks as their pictures: on by default, a saved choice kept.
    expect(parseFeedAppearance({}).chartMarkPics).toBe(true);
    expect(parseFeedAppearance({ chartMarkPics: false }).chartMarkPics).toBe(false);
    expect(parseFeedAppearance({}).chartMarkScale).toBe("m");
    expect(parseFeedAppearance({ chartMarkScale: "s" }).chartMarkScale).toBe("s");
    expect(parseFeedAppearance({ chartMarkScale: "xl" }).chartMarkScale).toBe("m");
    // Circle, no line to the candle, medium distance. A bad value falls back; a saved one stays.
    expect(parseFeedAppearance({})).toMatchObject({
      chartMarkShape: "circle",
      chartMarkStem: false,
      chartMarkGap: "m",
    });
    expect(
      parseFeedAppearance({ chartMarkShape: "diamond", chartMarkStem: true, chartMarkGap: "l" }),
    ).toMatchObject({ chartMarkShape: "diamond", chartMarkStem: true, chartMarkGap: "l" });
    expect(
      parseFeedAppearance({ chartMarkShape: "star", chartMarkStem: "yes", chartMarkGap: "xl" }),
    ).toMatchObject({ chartMarkShape: "circle", chartMarkStem: false, chartMarkGap: "m" });
    const {
      chartMarkShape: _shape,
      chartMarkStem: _stem,
      chartMarkGap: _gap,
      ...noMarkStyle
    } = DEFAULT_FEED_APPEARANCE;
    const filled = feedAppearanceSchema.safeParse(noMarkStyle);
    expect(filled.success && filled.data).toMatchObject({
      chartMarkShape: "circle",
      chartMarkStem: false,
      chartMarkGap: "m",
    });
    const styled = feedAppearanceSchema.safeParse({
      ...DEFAULT_FEED_APPEARANCE,
      chartMarkShape: "square",
      chartMarkStem: true,
      chartMarkGap: "s",
    });
    expect(styled.success && styled.data).toMatchObject({
      chartMarkShape: "square",
      chartMarkStem: true,
      chartMarkGap: "s",
    });
    // Chart event flags: every kind but the screen pass, and only the first filter and model.
    expect(parseFeedAppearance({}).chartEventKinds).toEqual([
      "alert",
      "filter",
      "model",
      "graduation",
      "scanned",
    ]);
    expect(parseFeedAppearance({}).chartEventFirst).toEqual(["filter", "model"]);
    expect(parseFeedAppearance({ chartEventKinds: ["screen", "model"] }).chartEventKinds).toEqual([
      "screen",
      "model",
    ]);
    expect(parseFeedAppearance({ chartEventFirst: ["alert"] }).chartEventFirst).toEqual(["alert"]);
    expect(parseFeedAppearance({ chartEventKinds: [] }).chartEventKinds).toEqual([]);
    expect(parseFeedAppearance({})).toMatchObject({
      chartEvents: true,
      chartEventLabels: true,
      chartEventScale: "m",
      chartEventEmphasis: "brand",
      chartTimeframeMs: null,
      chartLogScale: false,
      chartIndicators: ["vol"],
      chartShowDrawings: true,
      chartTrendExtend: false,
    });
    expect(parseFeedAppearance({}).chartFibLevels).toEqual([0, 0.236, 0.382, 0.5, 0.618, 0.786, 1]);
    expect(
      parseFeedAppearance({
        chartEvents: false,
        chartEventLabels: false,
        chartEventScale: "s",
        chartEventEmphasis: "mine",
        chartTimeframeMs: 15_000,
        chartLogScale: true,
        chartIndicators: ["rsi", "vol"],
        chartShowDrawings: false,
        chartFibLevels: [1, 0],
        chartTrendExtend: true,
      }),
    ).toMatchObject({
      chartEvents: false,
      chartEventLabels: false,
      chartEventScale: "s",
      chartEventEmphasis: "mine",
      chartTimeframeMs: 15_000,
      chartLogScale: true,
      chartIndicators: ["vol", "rsi"],
      chartShowDrawings: false,
      chartFibLevels: [0, 1],
      chartTrendExtend: true,
    });
    expect(storedAppearanceKeys(null)).toEqual([]);
    expect(storedAppearanceKeys([])).toEqual([]);
    expect(storedAppearanceKeys({ chartLogScale: false, theme: "dark" })).toEqual(["chartLogScale", "theme"]);
    expect(parseFeedAppearance({ chartTimeframeMs: 123 }).chartTimeframeMs).toBeNull();
    expect(parseFeedAppearance({ chartIndicators: ["nope"] }).chartIndicators).toEqual(["vol"]);
    expect(parseFeedAppearance({ chartIndicators: [] }).chartIndicators).toEqual([]);
    expect(parseFeedAppearance({ chartFibLevels: [] }).chartFibLevels).toEqual([
      0, 0.236, 0.382, 0.5, 0.618, 0.786, 1,
    ]);
    for (const bad of ["nope", 1, ["alert", "nope"], ["filter", "filter"]]) {
      expect(parseFeedAppearance({ chartEventKinds: bad }).chartEventKinds).toEqual([
        "alert",
        "filter",
        "model",
        "graduation",
        "scanned",
      ]);
      expect(parseFeedAppearance({ chartEventFirst: bad }).chartEventFirst).toEqual(["filter", "model"]);
    }
    expect(parseFeedAppearance({}).chartMarkKinds).toHaveLength(6);
    expect(parseFeedAppearance({}).chartMarkKinds).not.toContain("risky");
    expect(parseFeedAppearance({}).chartMarkKinds).not.toContain("winner");
    // A list saved before that with every kind on was the old default: it reads without risky or winners.
    const all = ["kol", "known", "funded", "probable", "dev", "risky", "winner", "linked"];
    expect(parseFeedAppearance({ chartMarkKinds: all }).chartMarkKinds).not.toContain("risky");
    expect(parseFeedAppearance({ chartMarkKinds: all }).chartMarkKinds).not.toContain("winner");
    // Risky turned back on against rev 2 stays; winners were still that default, so they go off.
    const riskyOn = parseFeedAppearance({ chartMarkKinds: all, chartMarksRev: 2 });
    expect(riskyOn.chartMarkKinds).toContain("risky");
    expect(riskyOn.chartMarkKinds).not.toContain("winner");
    // Turned back on since (saved with the new revision), or kept with another kind off, it stays.
    expect(parseFeedAppearance({ chartMarkKinds: all, chartMarksRev: 3 }).chartMarkKinds).toContain("risky");
    expect(parseFeedAppearance({ chartMarkKinds: all, chartMarksRev: 3 }).chartMarkKinds).toContain("winner");
    const rev2 = ["kol", "known", "funded", "probable", "dev", "winner", "linked"];
    expect(parseFeedAppearance({ chartMarkKinds: rev2, chartMarksRev: 2 }).chartMarkKinds).not.toContain(
      "winner",
    );
    expect(
      parseFeedAppearance({ chartMarkKinds: ["kol", "winner"], chartMarksRev: 2 }).chartMarkKinds,
    ).toEqual(["kol", "winner"]);
    expect(parseFeedAppearance({ chartMarkKinds: ["kol", "risky"] }).chartMarkKinds).toEqual([
      "kol",
      "risky",
    ]);
    expect(
      parseFeedAppearance({
        chartMarks: false,
        chartMarkKinds: ["kol", "nope", "kol", "dev"],
        chartMarkMinSol: 0.1,
      }),
    ).toMatchObject({ chartMarks: false, chartMarkKinds: ["kol", "dev"], chartMarkMinSol: 0.5 });
    // The card outline is the theme's neutral until picked, and colors by result by default.
    expect(parseFeedAppearance({})).toMatchObject({ outline: null, outlineResult: false });
    expect(parseFeedAppearance({ outline: "#AABBCC", outlineResult: false })).toMatchObject({
      outline: "#aabbcc",
      outlineResult: false,
    });
    expect(parseFeedAppearance({ outline: "grey" }).outline).toBe(null);
    // Hiding low market caps is on by default, at 6k; the slider runs 3k-20k in whole 1k steps.
    expect(parseFeedAppearance({})).toMatchObject({ hideBelowMcap: true, hideBelowMcapUsd: 6_000 });
    // A look saved before that with the old default (off at 5k) reads as the new one...
    expect(parseFeedAppearance({ hideBelowMcap: false, hideBelowMcapUsd: 5_000 })).toMatchObject({
      hideBelowMcap: true,
      hideBelowMcapUsd: 6_000,
    });
    // ...but one the user changed, or switched off since (saved with the new revision), stays.
    expect(parseFeedAppearance({ hideBelowMcap: false, hideBelowMcapUsd: 8_000 })).toMatchObject({
      hideBelowMcap: false,
      hideBelowMcapUsd: 8_000,
    });
    expect(parseFeedAppearance({ hideBelowMcap: true, hideBelowMcapUsd: 5_000 }).hideBelowMcapUsd).toBe(
      5_000,
    );
    expect(
      parseFeedAppearance({ hideBelowMcap: false, hideBelowMcapUsd: 5_000, hideBelowMcapRev: 2 }),
    ).toMatchObject({ hideBelowMcap: false, hideBelowMcapUsd: 5_000 });
    expect(parseFeedAppearance({ hideBelowMcap: true, hideBelowMcapUsd: 12_000 })).toMatchObject({
      hideBelowMcap: true,
      hideBelowMcapUsd: 12_000,
    });
    // The fees badge shows by default; a look saved off before that reads on, one switched off since stays off.
    expect(parseFeedAppearance({}).feesBadge).toBe(true);
    expect(parseFeedAppearance({ feesBadge: false }).feesBadge).toBe(true);
    expect(parseFeedAppearance({ feesBadge: false, feesBadgeRev: 2 }).feesBadge).toBe(false);
    for (const bad of [2_000, 21_000, 4_500, "8000"])
      expect(parseFeedAppearance({ hideBelowMcapUsd: bad }).hideBelowMcapUsd).toBe(6_000);
    // The score tile and TokenSage button are hidden by default. The calibrated 2x pill is not.
    // A saved field list, including one that hid it, is kept as is.
    expect(parseFeedAppearance({}).hidden).toEqual(["score", "sage", "snipers"]);
    expect(parseFeedAppearance(null).hidden).toEqual(["score", "sage", "snipers"]);
    expect(parseFeedAppearance({ hidden: ["score", "sage", "calibrated", "snipers"] }).hidden).toEqual([
      "score",
      "sage",
      "calibrated",
      "snipers",
    ]);
    // Dark until the user picks a theme; a saved "auto" keeps following the device.
    expect(parseFeedAppearance({}).theme).toBe("dark");
    expect(parseFeedAppearance({ theme: "auto" }).theme).toBe("auto");
    expect(parseFeedAppearance({ hidden: [] }).hidden).toEqual([]);
  });

  it("lets an older dashboard build save without the options added since", () => {
    const {
      volume,
      scoreColor,
      tileColors,
      tileFill,
      tileLow,
      tileMid,
      tileHigh,
      reasons,
      quickLinks,
      outline,
      outlineResult,
      hideBelowMcap,
      hideBelowMcapUsd,
      hideBelowMcapRev,
      chartMarkShape,
      chartMarkStem,
      chartMarkGap,
      chartEventKinds,
      chartEventFirst,
      ...older
    } = DEFAULT_FEED_APPEARANCE;
    const parsed = feedAppearanceSchema.safeParse(older);
    expect(parsed.success && parsed.data).toEqual({
      ...older,
      volume,
      scoreColor,
      tileColors,
      tileFill,
      tileLow,
      tileMid,
      tileHigh,
      reasons,
      quickLinks,
      outline,
      outlineResult,
      hideBelowMcap,
      hideBelowMcapUsd,
      hideBelowMcapRev,
      chartMarkShape,
      chartMarkStem,
      chartMarkGap,
      chartEventKinds,
      chartEventFirst,
    });
  });
});

describe("parseHiddenTokens", () => {
  it("defaults to auto-unhide on, drops unreadable or repeated entries and keeps the newest", () => {
    expect(parseHiddenTokens(null)).toEqual(DEFAULT_HIDDEN_TOKENS);
    const entry = (tokenId: string) => ({
      tokenId,
      mintAddress: null,
      symbol: "FOO",
      name: null,
      imageUrl: null,
      hiddenAt: "2026-10-19T00:00:00.000Z",
      baseMcapUsd: 10_000,
      reachedX: 2,
      graduated: false,
    });
    const out = parseHiddenTokens({
      autoUnhide: false,
      tokens: [entry("a"), { tokenId: "b" }, entry("a"), "junk", entry("c")],
    });
    expect(out).toEqual({ autoUnhide: false, tokens: [entry("a"), entry("c")] });
    const many = Array.from({ length: MAX_HIDDEN_TOKENS + 5 }, (_, i) => entry(`t${i}`));
    const kept = parseHiddenTokens({ tokens: many }).tokens;
    expect(kept).toHaveLength(MAX_HIDDEN_TOKENS);
    expect(kept[0]!.tokenId).toBe("t5");
  });
});

const TRADE_PREFS = {
  buyPresets: [0.1, 0.5, 1],
  sellPresets: [25, 50, 100],
  slippagePct: 20,
  speed: "turbo",
  mevProtect: false,
  priorityMode: "custom",
  customPrioritySol: 0.0005,
  customTipSol: null,
  buyRows: 1,
  quickBuy: { enabled: true, amountSol: 0.2, position: "bottom-left", size: "l", color: "blue" },
  alwaysShowHeld: true,
};

describe("parseUserPrefs", () => {
  it("reads each section on its own, and a missing or broken one as null", () => {
    expect(parseUserPrefs(null)).toEqual({ trade: null, layout: null });
    expect(parseUserPrefs([1, 2])).toEqual({ trade: null, layout: null });
    const layout = { liveView: "scope", tokenSide: "trades" };
    expect(parseUserPrefs({ layout, trade: { ...TRADE_PREFS, slippagePct: 900 } })).toEqual({
      trade: null,
      layout,
    });
    expect(parseUserPrefs({ trade: TRADE_PREFS, other: 1 })).toEqual({ trade: TRADE_PREFS, layout: null });
  });
});

describe.skipIf(!dbAvailable)("settings routes", () => {
  const env: Env = dbAvailable
    ? { ...loadEnv(), ADMIN_WALLET_ADDRESSES: ADMIN_WALLET, WEB_PUSH_PUBLIC_KEY: "BPublicKeyForTests" }
    : (undefined as never);
  let app: FastifyInstance;
  const cookies: Record<"user" | "admin", string> = { user: "", admin: "" };
  const userIds: string[] = [];

  const call = (who: "user" | "admin", method: "GET" | "PUT" | "POST", url: string, payload?: unknown) =>
    app.inject({ method, url, payload: payload as never, cookies: { [SESSION_COOKIE_NAME]: cookies[who] } });

  beforeAll(async () => {
    resetContestStateCache();
    await prisma.user.deleteMany({ where: { walletAddress: { in: [WALLET, ADMIN_WALLET] } } });
    const signer = createSessionSigner(env.JWT_SECRET, env.SESSION_TTL_HOURS);
    const user = await prisma.user.create({
      data: {
        walletAddress: WALLET,
        subscription: { create: { expiresAt: new Date(Date.now() + 10.5 * 86_400_000), source: "BURN" } },
      },
    });
    const admin = await prisma.user.create({ data: { walletAddress: ADMIN_WALLET } });
    userIds.push(user.id, admin.id);
    cookies.user = await signer.sign({ userId: user.id, walletAddress: WALLET });
    cookies.admin = await signer.sign({ userId: admin.id, walletAddress: ADMIN_WALLET });
    app = await buildServer(env);
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await app?.close();
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  });

  it("reports default alert settings and the user's access", async () => {
    const res = await call("user", "GET", "/settings");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.alerts).toEqual(DEFAULT_ALERT_PREFS);
    expect(body.appearance).toEqual(DEFAULT_FEED_APPEARANCE);
    expect(body.appearanceKeys).toEqual([]);
    expect(body.account.walletAddress).toBe(WALLET);
    expect(body.account.access).toMatchObject({
      hasAccess: true,
      level: "subscription",
      subscription: { source: "BURN" },
      burns: 0,
    });

    const admin = (await call("admin", "GET", "/settings")).json();
    expect(admin.account.access).toMatchObject({ hasAccess: true, level: "admin", expiresAt: null });
  });

  it("saves a partial change and keeps the rest", async () => {
    const res = await call("user", "PUT", "/settings/alerts", {
      sound: "radar",
      volume: 35,
      notifyOn: { filterMatches: false },
    });
    expect(res.statusCode).toBe(200);
    const expected = {
      ...DEFAULT_ALERT_PREFS,
      sound: "radar",
      volume: 35,
      notifyOn: { filterMatches: false, modelCalls: true },
    };
    expect(res.json().alerts).toEqual(expected);
    expect((await call("user", "GET", "/settings")).json().alerts).toEqual(expected);
  });

  it("keeps every change when several saves land at once", async () => {
    const changes = [
      { sound: "bell" },
      { volume: 12 },
      { soundEnabled: false },
      { browserNotifications: true },
    ];
    const results = await Promise.all(changes.map((c) => call("user", "PUT", "/settings/alerts", c)));
    expect(results.map((r) => r.statusCode)).toEqual([200, 200, 200, 200]);
    const alerts = (await call("user", "GET", "/settings")).json().alerts;
    expect(alerts).toMatchObject({
      sound: "bell",
      volume: 12,
      soundEnabled: false,
      browserNotifications: true,
    });
  });

  it("saves Chaos Mode's switch, site and per-minute cap", async () => {
    const res = await call("user", "PUT", "/settings/alerts", {
      chaosMode: true,
      chaosSite: "pumpfun",
      chaosPerMinute: 25,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().alerts).toMatchObject({ chaosMode: true, chaosSite: "pumpfun", chaosPerMinute: 25 });
    const back = await call("user", "PUT", "/settings/alerts", { chaosSite: null });
    expect(back.json().alerts).toMatchObject({ chaosMode: true, chaosSite: null, chaosPerMinute: 25 });
  });

  it("rejects unknown sounds, out-of-range volume and unknown fields", async () => {
    expect((await call("user", "PUT", "/settings/alerts", { chaosSite: "bullx" })).statusCode).toBe(400);
    expect((await call("user", "PUT", "/settings/alerts", { chaosPerMinute: 0 })).statusCode).toBe(400);
    expect((await call("user", "PUT", "/settings/alerts", { chaosPerMinute: 61 })).statusCode).toBe(400);
    expect((await call("user", "PUT", "/settings/alerts", { sound: "foghorn" })).statusCode).toBe(400);
    expect((await call("user", "PUT", "/settings/alerts", { volume: 101 })).statusCode).toBe(400);
    expect((await call("user", "PUT", "/settings/alerts", { extra: true })).statusCode).toBe(400);
    expect((await call("user", "PUT", "/settings/alerts", {})).statusCode).toBe(400);
  });

  it("saves the feed appearance whole and rejects anything out of bounds", async () => {
    const look = {
      ...DEFAULT_FEED_APPEARANCE,
      theme: "light",
      accent: "#FF00AA",
      density: "compact",
      columns: 3,
      phoneColumns: 2,
      textSize: 90,
      hidden: ["reasons", "links"],
    };
    const res = await call("user", "PUT", "/settings/appearance", look);
    expect(res.statusCode).toBe(200);
    const saved = { ...look, accent: "#ff00aa" };
    expect(res.json().appearance).toEqual(saved);
    const read = (await call("user", "GET", "/settings")).json();
    expect(read.appearance).toEqual(saved);
    expect(read.appearanceKeys).toEqual(
      expect.arrayContaining(["theme", "chartLogScale", "chartEventKinds"]),
    );
    // The alert settings live beside it and are untouched.
    expect((await call("user", "GET", "/settings")).json().alerts.sound).toBeDefined();

    const bad = [
      { ...look, accent: "url(x)" },
      { ...look, textSize: 300 },
      { ...look, columns: 5 },
      { ...look, hidden: ["reasons", "reasons"] },
      { ...look, hidden: ["nope"] },
      { ...look, extra: 1 },
      { theme: "dark" },
    ];
    for (const b of bad) expect((await call("user", "PUT", "/settings/appearance", b)).statusCode).toBe(400);
    expect((await call("user", "GET", "/settings")).json().appearance).toEqual(saved);
    expect((await app.inject({ method: "PUT", url: "/settings/appearance", payload: look })).statusCode).toBe(
      401,
    );
  });

  it("saves the hidden tokens whole and rejects anything out of bounds", async () => {
    expect((await call("user", "GET", "/settings")).json().hiddenTokens).toEqual(DEFAULT_HIDDEN_TOKENS);
    const hidden = {
      autoUnhide: false,
      tokens: [
        {
          tokenId: "tok1",
          mintAddress: "Mint1111",
          symbol: "FOO",
          name: "Foo",
          imageUrl: "https://example.com/foo.png",
          hiddenAt: "2026-10-19T00:00:00.000Z",
          baseMcapUsd: 12_000,
          reachedX: 0,
          graduated: false,
        },
      ],
    };
    const res = await call("user", "PUT", "/settings/hidden-tokens", hidden);
    expect(res.statusCode).toBe(200);
    expect(res.json().hiddenTokens).toEqual(hidden);
    expect((await call("user", "GET", "/settings")).json().hiddenTokens).toEqual(hidden);

    const bad = [
      { ...hidden, extra: 1 },
      { ...hidden, tokens: [{ ...hidden.tokens[0], hiddenAt: "yesterday" }] },
      { ...hidden, tokens: [{ ...hidden.tokens[0], tokenId: "" }] },
      { autoUnhide: "yes" },
    ];
    for (const b of bad)
      expect((await call("user", "PUT", "/settings/hidden-tokens", b)).statusCode).toBe(400);
    expect((await call("user", "GET", "/settings")).json().hiddenTokens).toEqual(hidden);
    expect(
      (await app.inject({ method: "PUT", url: "/settings/hidden-tokens", payload: hidden })).statusCode,
    ).toBe(401);
  });

  it("saves Scope's settings whole and rejects anything out of bounds", async () => {
    expect((await call("user", "GET", "/settings")).json().scopeSettings).toBeNull();
    const scope = {
      display: { stream: true, density: "compact", chips: ["holders", "top10"], hiddenColumns: [] },
      columns: { models: { mcapMin: 10_000, mcapMax: null, socials: "x", models: ["Narrative"] } },
    };
    const res = await call("user", "PUT", "/settings/scope", scope);
    expect(res.statusCode).toBe(200);
    expect(res.json().scopeSettings).toEqual(scope);
    expect((await call("user", "GET", "/settings")).json().scopeSettings).toEqual(scope);

    const bad = [
      { ...scope, extra: 1 },
      { display: scope.display },
      { ...scope, columns: { nope: {} } },
      { ...scope, display: { stream: { deep: true } } },
      { ...scope, display: { density: "x".repeat(41) } },
      { ...scope, display: Object.fromEntries(Array.from({ length: 61 }, (_, i) => [`k${i}`, true])) },
    ];
    for (const b of bad) expect((await call("user", "PUT", "/settings/scope", b)).statusCode).toBe(400);
    expect((await call("user", "GET", "/settings")).json().scopeSettings).toEqual(scope);

    // Chosen columns (user ask 2026-10-23): up to six, up to three picks each.
    const col = (id: string, kind: string, picks: string[] = []) => ({
      id,
      kind,
      picks,
      filter: { hideMissed: true },
    });
    const board = {
      display: { density: "cozy" },
      board: [col("new", "new"), col("model", "model", ["m1", "m2"])],
    };
    expect((await call("user", "PUT", "/settings/scope", board)).statusCode).toBe(200);
    expect((await call("user", "GET", "/settings")).json().scopeSettings).toEqual(board);
    const badBoards = [
      { ...board, board: [] },
      { ...board, board: Array.from({ length: 7 }, (_, i) => col(`c${i}`, "new")) },
      { ...board, board: [col("m", "model", ["a", "b", "c", "d"])] },
      { ...board, board: [{ ...col("n", "new"), extra: 1 }] },
    ];
    for (const b of badBoards) expect((await call("user", "PUT", "/settings/scope", b)).statusCode).toBe(400);
    expect((await call("user", "GET", "/settings")).json().scopeSettings).toEqual(board);
    expect((await app.inject({ method: "PUT", url: "/settings/scope", payload: scope })).statusCode).toBe(
      401,
    );
  });

  it("saves each synced section whole, keeps the others, and keeps accounts apart", async () => {
    expect((await call("user", "GET", "/settings")).json().prefs).toEqual({ trade: null, layout: null });
    const layout = { liveView: "scope", tokenSide: "holders" };
    expect((await call("user", "PUT", "/settings/prefs/layout", layout)).statusCode).toBe(200);
    const res = await call("user", "PUT", "/settings/prefs/trade", TRADE_PREFS);
    expect(res.statusCode).toBe(200);
    expect(res.json().prefs).toEqual({ trade: TRADE_PREFS, layout });
    expect((await call("user", "GET", "/settings/prefs")).json().prefs).toEqual({
      trade: TRADE_PREFS,
      layout,
    });
    expect((await call("user", "GET", "/settings")).json().prefs).toEqual({ trade: TRADE_PREFS, layout });
    // Another account sees only its own.
    expect((await call("admin", "GET", "/settings/prefs")).json().prefs).toEqual({
      trade: null,
      layout: null,
    });

    const bad: [string, unknown][] = [
      ["trade", { ...TRADE_PREFS, slippagePct: 51 }],
      ["trade", { ...TRADE_PREFS, customPrioritySol: 0.5 }],
      ["trade", { ...TRADE_PREFS, buyPresets: Array.from({ length: 11 }, () => 1) }],
      ["trade", { ...TRADE_PREFS, quickBuy: { ...TRADE_PREFS.quickBuy, color: "<script>" } }],
      ["trade", { ...TRADE_PREFS, extra: 1 }],
      ["layout", { ...layout, tokenSide: "elsewhere" }],
      ["layout", { liveView: "list", tokenSide: "map" }],
    ];
    for (const [section, body] of bad) {
      expect((await call("user", "PUT", `/settings/prefs/${section}`, body)).statusCode).toBe(400);
    }
    expect((await call("user", "PUT", "/settings/prefs/nope", {})).statusCode).toBe(404);
    expect((await call("user", "GET", "/settings/prefs")).json().prefs).toEqual({
      trade: TRADE_PREFS,
      layout,
    });
    expect(
      (await app.inject({ method: "PUT", url: "/settings/prefs/layout", payload: layout })).statusCode,
    ).toBe(401);
    expect((await app.inject({ method: "GET", url: "/settings/prefs" })).statusCode).toBe(401);
  });

  it("keeps both sections when they are saved at once", async () => {
    const layout = { liveView: "cards", tokenSide: "none" };
    const trade = { ...TRADE_PREFS, slippagePct: 12 };
    const [a, b] = await Promise.all([
      call("admin", "PUT", "/settings/prefs/layout", layout),
      call("admin", "PUT", "/settings/prefs/trade", trade),
    ]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    expect((await call("admin", "GET", "/settings/prefs")).json().prefs).toEqual({ trade, layout });
  });

  it("needs a session", async () => {
    const res = await app.inject({ method: "GET", url: "/settings" });
    expect(res.statusCode).toBe(401);
  });

  it("follows the best performer until models are picked by hand, and back", async () => {
    type Board = { selectedModels: string[]; followBest: boolean; defaultModel: string };
    const board = async () => (await call("admin", "GET", "/curated/models?days=30")).json() as Board;
    const start = await board();
    expect(start.followBest).toBe(true);
    expect(start.selectedModels).toEqual([start.defaultModel]);

    // Picking by hand switches to "keep my picks".
    let res = await call("admin", "PUT", "/curated/feed", { models: ["rules", "trees"] });
    expect(res.json()).toMatchObject({ selectedModels: ["rules", "trees"], followBest: false });

    // Back to following: the feed shows the best, and the picks are kept for later.
    res = await call("admin", "PUT", "/curated/feed", { followBest: true });
    expect(res.json()).toMatchObject({ selectedModels: [start.defaultModel], followBest: true });
    res = await call("admin", "PUT", "/curated/feed", { followBest: false });
    expect(res.json()).toMatchObject({ selectedModels: ["rules", "trees"], followBest: false });

    // Clearing the picks follows the best again.
    res = await call("admin", "PUT", "/curated/feed", { models: null });
    expect(res.json()).toMatchObject({ followBest: true });

    // Switching to "keep my picks" with nothing picked freezes today's best as the pick.
    res = await call("admin", "PUT", "/curated/feed", { followBest: false });
    expect(res.json()).toMatchObject({ selectedModels: [start.defaultModel], followBest: false });
  });

  it("never lets 'keep my picks' overwrite picks saved by a concurrent request", async () => {
    // Seeding today's best used to read the auth-time snapshot (no picks yet) and write after
    // the concurrent PUT had saved real picks, replacing them with the default.
    type Board = { selectedModels: string[]; followBest: boolean };
    await call("admin", "PUT", "/curated/feed", { models: null });
    await Promise.all([
      call("admin", "PUT", "/curated/feed", { models: ["rules", "trees"] }),
      call("admin", "PUT", "/curated/feed", { followBest: false }),
    ]);
    const after = (await call("admin", "GET", "/curated/models?days=30")).json() as Board;
    expect(after).toMatchObject({ selectedModels: ["rules", "trees"], followBest: false });
  });

  it("adds this browser as a push target, keeps its cursor on re-send, and removes it", async () => {
    expect((await call("user", "GET", "/settings")).json().push).toEqual({ publicKey: "BPublicKeyForTests" });
    const sub = {
      endpoint: "https://fcm.googleapis.com/fcm/send/settings-test",
      keys: { p256dh: "B".repeat(87), auth: "a".repeat(22) },
    };
    expect((await call("user", "PUT", "/settings/push", sub)).statusCode).toBe(200);
    const row = await prisma.webPushSubscription.findUniqueOrThrow({ where: { endpoint: sub.endpoint } });
    expect((await call("user", "PUT", "/settings/push", sub)).statusCode).toBe(200);
    const again = await prisma.webPushSubscription.findUniqueOrThrow({ where: { endpoint: sub.endpoint } });
    expect(again.sentThrough).toEqual(row.sentThrough);

    // Another account taking the same browser moves it, with a fresh cursor.
    expect((await call("admin", "PUT", "/settings/push", sub)).statusCode).toBe(200);
    const moved = await prisma.webPushSubscription.findUniqueOrThrow({ where: { endpoint: sub.endpoint } });
    expect(moved.userId).not.toBe(row.userId);

    // Only its own account can remove it.
    await call("user", "POST", "/settings/push/remove", { endpoint: sub.endpoint });
    expect(await prisma.webPushSubscription.count({ where: { endpoint: sub.endpoint } })).toBe(1);
    await call("admin", "POST", "/settings/push/remove", { endpoint: sub.endpoint });
    expect(await prisma.webPushSubscription.count({ where: { endpoint: sub.endpoint } })).toBe(0);
  });

  it("refuses an endpoint that isn't a public https push service", async () => {
    const res = await call("user", "PUT", "/settings/push", {
      endpoint: "https://169.254.169.254/latest/meta-data",
      keys: { p256dh: "B".repeat(87), auth: "a".repeat(22) },
    });
    expect(res.statusCode).toBe(400);
  });
});
