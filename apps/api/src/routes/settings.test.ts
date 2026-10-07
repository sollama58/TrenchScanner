// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnv, prisma, type Env } from "@trenchscanner/core";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../server.js";
import { createSessionSigner, SESSION_COOKIE_NAME } from "../auth/session.js";
import { resetContestStateCache } from "../contest.js";
import { DEFAULT_ALERT_PREFS, parseAlertPrefs } from "../alertPrefs.js";
import { DEFAULT_FEED_APPEARANCE, feedAppearanceSchema, parseFeedAppearance } from "../feedAppearance.js";

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
    expect(
      parseFeedAppearance({ reasons: true, quickLinks: ["gmgn", "padre", "gmgn", "axiom"] }),
    ).toMatchObject({
      reasons: true,
      quickLinks: ["gmgn", "axiom"],
    });
    expect(parseFeedAppearance({ quickLinks: [] }).quickLinks).toEqual([]);
  });

  it("lets an older dashboard build save without the options added since", () => {
    const { volume, scoreColor, reasons, quickLinks, ...older } = DEFAULT_FEED_APPEARANCE;
    const parsed = feedAppearanceSchema.safeParse(older);
    expect(parsed.success && parsed.data).toEqual({ ...older, volume, scoreColor, reasons, quickLinks });
  });
});

describe.skipIf(!dbAvailable)("settings routes", () => {
  const env: Env = dbAvailable
    ? { ...loadEnv(), ADMIN_WALLET_ADDRESSES: ADMIN_WALLET }
    : (undefined as never);
  let app: FastifyInstance;
  const cookies: Record<"user" | "admin", string> = { user: "", admin: "" };
  const userIds: string[] = [];

  const call = (who: "user" | "admin", method: "GET" | "PUT", url: string, payload?: unknown) =>
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

  it("rejects unknown sounds, out-of-range volume and unknown fields", async () => {
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
    expect((await call("user", "GET", "/settings")).json().appearance).toEqual(saved);
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
});
