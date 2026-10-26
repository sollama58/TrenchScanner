// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { createHash, randomBytes } from "node:crypto";
import bs58 from "bs58";
import { AccessSource } from "@prisma/client";
import { loadEnv, notifyHolderReadingWritten, prisma, type Env } from "@trenchscanner/core";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createSessionSigner, SESSION_COOKIE_NAME } from "../auth/session.js";
import { resetContestStateCache } from "../contest.js";
import {
  extensionKeyMatches,
  extensionRateLimitBucket,
  hashExtensionKey,
  isExtensionKeyShape,
  newExtensionKey,
} from "../extensionKey.js";
import { isMintAddress, resetOverlayLookupCache } from "../extensionLookup.js";
import { hashModelAlertKey } from "../modelAlertKey.js";
import { DEFAULT_OVERLAY_SETTINGS, parseOverlaySettings } from "../overlaySettings.js";
import { buildServer } from "../server.js";
import { resetExtensionAuthState } from "./extension.js";

const mint = () => bs58.encode(randomBytes(32));

describe("extension keys", () => {
  it("only accepts its own shape and peppers apart from Model Alert keys", () => {
    const server = "p".repeat(32);
    const minted = newExtensionKey(server);
    expect(isExtensionKeyShape(minted.secret)).toBe(true);
    expect(isExtensionKeyShape(`tsma_${"a".repeat(43)}`)).toBe(false);
    expect(minted.secretHash).not.toBe(createHash("sha256").update(minted.secret).digest("hex"));
    expect(minted.secretHash).not.toBe(hashModelAlertKey(minted.secret, server));
    expect(minted.secretHash).toBe(hashExtensionKey(minted.secret, server));
    expect(extensionKeyMatches(minted.secret, minted.secretHash, server)).toBe(true);
    expect(extensionKeyMatches(minted.secret, minted.secretHash, "q".repeat(32))).toBe(false);
    expect(minted.prefix.length).toBeLessThan(minted.secret.length);
  });

  it("buckets rate limits by a digest of a real-shaped key, else the address", () => {
    const { secret } = newExtensionKey("p".repeat(32));
    const bucket = extensionRateLimitBucket(`Bearer ${secret}`, "ip:1.2.3.4");
    expect(bucket).toMatch(/^ext:[0-9a-f]{32}$/);
    expect(bucket).not.toContain(secret.slice(4, 15));
    expect(extensionRateLimitBucket("Bearer nope", "ip:1.2.3.4")).toBe("ip:1.2.3.4");
    expect(extensionRateLimitBucket(undefined, "ip:1.2.3.4")).toBe("ip:1.2.3.4");
  });

  it("validates mint addresses as 32-byte base58", () => {
    expect(isMintAddress(mint())).toBe(true);
    expect(isMintAddress("So11111111111111111111111111111111111111112")).toBe(true);
    expect(isMintAddress("GPs…pump")).toBe(false);
    expect(isMintAddress("0".repeat(44))).toBe(false);
    expect(isMintAddress(bs58.encode(randomBytes(31)))).toBe(false);
  });

  it("reads stored overlay settings field by field", () => {
    expect(parseOverlaySettings(null)).toEqual(DEFAULT_OVERLAY_SETTINGS);
    const parsed = parseOverlaySettings({
      rings: { modelAlerts: false, filterMatches: "yes" },
      style: { ring: "spiral", calmMotion: true },
      flags: { bundledSupplyPct: { on: false, threshold: 30 }, devWalletPct: { on: true } },
    });
    expect(parsed.rings.modelAlerts).toBe(false);
    expect(parsed.rings.filterMatches).toBe(true);
    expect(parsed.style).toEqual({ ring: "halo", calmMotion: true });
    expect(parsed.flags.bundledSupplyPct).toEqual({ on: false, threshold: 30 });
    expect(parsed.flags.devWalletPct).toEqual(DEFAULT_OVERLAY_SETTINGS.flags.devWalletPct);
    expect(parsed.sites).toEqual({ axiom: true, terminal: true, gmgn: true });
  });
});

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const TAG = `ext-${Date.now()}`;

describe.skipIf(!dbAvailable)("extension overlay api", () => {
  let app: FastifyInstance;
  // Admin wallets: the feed carries the AI reviewer's verdicts to these only (audit CE-1).
  const ADMINS = ["feed"];
  const env: Env = dbAvailable
    ? { ...loadEnv(), ADMIN_WALLET_ADDRESSES: ADMINS.map((s) => `${TAG}-${s}`).join(",") }
    : (undefined as never);
  const signer = dbAvailable
    ? createSessionSigner(env.JWT_SECRET, env.SESSION_TTL_HOURS)
    : (undefined as never);
  const mints: string[] = [];

  async function makeUser(suffix: string, paid: boolean) {
    const walletAddress = `${TAG}-${suffix}`;
    const row = await prisma.user.create({
      data: { walletAddress, feedModels: ["rules"], curatedModel: "rules", followBestModel: false },
    });
    if (paid) {
      await prisma.subscription.create({
        data: { userId: row.id, expiresAt: new Date(Date.now() + 86_400_000), source: AccessSource.BURN },
      });
    }
    const cookie = await signer.sign({ userId: row.id, walletAddress, sessionVersion: 0 });
    return { id: row.id, cookie };
  }

  const session = (cookie: string, method: "GET" | "POST" | "DELETE", url: string, headers = {}) =>
    app.inject({ method, url, cookies: { [SESSION_COOKIE_NAME]: cookie }, headers });
  const ext = (key: string | null, method: "GET" | "POST" | "PUT", url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      payload: payload as never,
      headers: {
        origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      },
    });

  beforeAll(async () => {
    resetContestStateCache();
    resetOverlayLookupCache();
    resetExtensionAuthState();
    app = await buildServer(env);
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    if (!dbAvailable) return;
    await prisma.token.deleteMany({ where: { mintAddress: { in: mints } } });
    await prisma.user.deleteMany({ where: { walletAddress: { startsWith: TAG } } });
  }, 30_000);

  it("creates keys for paid access only, up to the cap, and lists prefixes", async () => {
    const free = await makeUser("free", false);
    const refused = await session(free.cookie, "POST", "/settings/extension-keys");
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toMatch(/browser extension/);

    const paid = await makeUser("cap", true);
    const secrets: string[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await session(paid.cookie, "POST", "/settings/extension-keys");
      expect(res.statusCode).toBe(200);
      secrets.push((res.json() as { secret: string }).secret);
    }
    expect(secrets.every((s) => s.startsWith("tsx_"))).toBe(true);
    expect((await session(paid.cookie, "POST", "/settings/extension-keys")).statusCode).toBe(409);
    const list = await session(paid.cookie, "GET", "/settings/extension-keys");
    expect(list.json().keys).toHaveLength(3);
    expect(JSON.stringify(list.json())).not.toContain(secrets[0]);
  });

  it("refuses missing, malformed and unknown keys, and a Model Alert key", async () => {
    expect((await ext(null, "GET", "/ext/v1/me")).statusCode).toBe(401);
    expect((await ext("tsx_short", "GET", "/ext/v1/me")).statusCode).toBe(401);
    expect((await ext(newExtensionKey("x".repeat(32)).secret, "GET", "/ext/v1/me")).statusCode).toBe(401);
    expect((await ext(`tsma_${"a".repeat(43)}`, "GET", "/ext/v1/me")).statusCode).toBe(401);
  });

  it("buckets made-up keys by address, so they can't flush a proven key's limit", async () => {
    const user = await makeUser("junk", true);
    const real = (await session(user.cookie, "POST", "/settings/extension-keys")).json().secret as string;
    // An address of its own, so the other tests' buckets are untouched.
    const from = (key: string) =>
      app.inject({
        method: "GET",
        url: "/ext/v1/me",
        headers: {
          origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
          authorization: `Bearer ${key}`,
          "cf-connecting-ip": "203.0.113.7",
        },
      });
    resetExtensionAuthState();
    expect((await from(real)).statusCode).toBe(200);
    try {
      const codes: number[] = [];
      for (let i = 0; i < 25; i++)
        codes.push((await from(newExtensionKey(String(i).padStart(32, "j")).secret)).statusCode);
      // The address's one bucket: the real key's first (unproven) request, then 19 made-up keys.
      expect(codes.slice(0, 19).every((c) => c === 401)).toBe(true);
      expect(codes.slice(19).every((c) => c === 429)).toBe(true);
      // The key proven before the junk has its own bucket and still works.
      expect((await from(real)).statusCode).toBe(200);
    } finally {
      resetExtensionAuthState();
    }
  });

  it("never reads a session cookie on /ext/v1", async () => {
    const user = await makeUser("cookie", true);
    const res = await app.inject({
      method: "GET",
      url: "/ext/v1/me",
      cookies: { [SESSION_COOKIE_NAME]: user.cookie },
    });
    expect(res.statusCode).toBe(401);
  });

  it("lists the reader's recent alerts: matches, followed calls, AI verdict and flags", async () => {
    const user = await makeUser("feed", true);
    const key = (await session(user.cookie, "POST", "/settings/extension-keys")).json().secret as string;

    const trackedMint = mint();
    const untrackedMint = mint();
    mints.push(trackedMint, untrackedMint);
    const token = await prisma.token.create({
      data: { mintAddress: trackedMint, symbol: "RING", name: "Ring Coin" },
    });
    const snapshot = await prisma.tokenSnapshot.create({
      data: {
        tokenId: token.id,
        priceUsd: 0.00001,
        marketCapUsd: 6_100,
        bundledSupplyPct: 2,
        sniperTopHolderCount: 0,
        linkedWalletPct: 14,
        devWalletPct: 0,
      },
    });
    const filter = await prisma.userFilter.create({
      data: { userId: user.id, name: "Clean launch", mcapMin: 1, mcapMax: 1e9 },
    });
    await prisma.match.create({
      data: {
        userId: user.id,
        filterId: filter.id,
        tokenId: token.id,
        snapshotId: snapshot.id,
        score: 60,
        alertMcapUsd: 6_100,
        matchedAt: new Date(Date.now() - 10 * 60_000),
      },
    });
    await prisma.match.create({
      data: {
        userId: user.id,
        filterId: filter.id,
        tokenId: token.id,
        snapshotId: snapshot.id,
        score: 70,
        alertMcapUsd: 30_000,
      },
    });
    const callBase = {
      tokenId: token.id,
      snapshotId: snapshot.id,
      source: "test",
      anchorPriceUsd: 0.00001,
      anchorMcapUsd: 6_100,
    };
    await prisma.curatedAlert.create({
      data: {
        ...callBase,
        model: "rules",
        modelName: "Rules",
        confidence: 74,
        tier: "high",
        calibratedPct: 41,
        createdAt: new Date(Date.now() - 10 * 60_000),
      },
    });
    // A later re-call at a higher cap doesn't stand in for the call that alerted the reader.
    await prisma.curatedAlert.create({
      data: {
        ...callBase,
        anchorMcapUsd: 30_000,
        model: "rules",
        modelName: "Rules",
        confidence: 80,
        tier: "high",
        calibratedPct: 50,
      },
    });
    await prisma.curatedAlert.create({
      data: { ...callBase, model: "zz-not-followed", modelName: "Other", confidence: 90, tier: "standard" },
    });
    await prisma.aiReview.create({
      data: {
        tokenId: token.id,
        mode: "live",
        model: "test",
        decision: "buy",
        probability2x: 0.6,
        reasoning: "x".repeat(400),
        latencyMs: 10,
        anchorPriceUsd: 0.00001,
        anchorMcapUsd: 6_100,
      },
    });

    // A token nobody alerted on stays out of the list.
    await prisma.token.create({ data: { mintAddress: untrackedMint, symbol: "QUIET" } });

    const res = await ext(key, "GET", "/ext/v1/feed");
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      tokens: {
        mint: string;
        stats: Record<string, unknown>;
        modelCalls: { model: string; calibratedPct: number; mcapUsd: number }[];
        filterMatches: { filterName: string; mcapUsd: number }[];
        ai: { decision: string; reasoning: string };
      }[];
    };
    const t = body.tokens.find((x) => x.mint === trackedMint);
    expect(body.tokens.some((x) => x.mint === untrackedMint)).toBe(false);
    expect(t!.stats).toMatchObject({ marketCapUsd: 6_100, bundledSupplyPct: 2, linkedWalletPct: 14 });
    expect(t!.filterMatches.map((m) => [m.filterName, m.mcapUsd])).toEqual([["Clean launch", 6_100]]);
    expect(t!.modelCalls.map((c) => [c.model, c.mcapUsd, c.calibratedPct])).toEqual([["rules", 6_100, 41]]);
    expect(t!.ai.decision).toBe("buy");
    expect(t!.ai.reasoning.length).toBe(280);

    // Another reader following the same model sees the call but never this reader's filter match.
    const other = await makeUser("other", true);
    const otherKey = (await session(other.cookie, "POST", "/settings/extension-keys")).json()
      .secret as string;
    const otherRes = await ext(otherKey, "GET", "/ext/v1/feed");
    const seen = (otherRes.json().tokens as { mint: string; filterMatches: unknown[] }[]).find(
      (x) => x.mint === trackedMint,
    );
    expect(seen!.filterMatches).toEqual([]);
    // A paid reader who isn't an admin never gets the AI reviewer's verdict.
    expect((seen as unknown as { ai: unknown }).ai).toBeNull();
    expect((await ext(otherKey, "GET", "/ext/v1/me")).json().aiReviews).toBe(false);
    expect((await ext(key, "GET", "/ext/v1/me")).json().aiReviews).toBe(true);

    // The old row lookup is gone: nothing takes addresses from a page.
    expect((await ext(key, "POST", "/ext/v1/lookup", { mints: [trackedMint] })).statusCode).toBe(404);
  });

  it("answers one coin's card for the panel's lookup, stored or not", async () => {
    const user = await makeUser("coin", true);
    const key = (await session(user.cookie, "POST", "/settings/extension-keys")).json().secret as string;
    const [stored, unknown] = [mint(), mint()];
    mints.push(stored, unknown);
    // The newest scan's empty-wallet lookups didn't all land: the last known share stands in.
    const token = await prisma.token.create({
      data: { mintAddress: stored, symbol: "LOOK", lastEmptyTop10WalletPct: 30 },
    });
    await prisma.tokenSnapshot.create({
      data: {
        tokenId: token.id,
        priceUsd: 0.00001,
        marketCapUsd: 9_000,
        rugScreenPassed: false,
        rugScreenReasons: ["mint authority active"],
        takenAt: new Date(),
      },
    });
    const res = await ext(key, "GET", `/ext/v1/token/${stored}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().token).toMatchObject({
      mint: stored,
      symbol: "LOOK",
      safety: { passed: false, reasons: ["mint authority active"] },
      stats: { emptyTop10WalletCount: 3 },
      modelCalls: [],
      filterMatches: [],
      ai: null,
    });
    expect((await ext(key, "GET", `/ext/v1/token/${unknown}`)).json()).toEqual({ token: null });
    expect((await ext(key, "GET", "/ext/v1/token/not-a-mint")).statusCode).toBe(400);
    expect((await ext(null, "GET", `/ext/v1/token/${stored}`)).statusCode).toBe(401);
  });

  it("answers the newest scan's safety verdict of the coins on a board, and nothing else", async () => {
    const user = await makeUser("safety", true);
    const key = (await session(user.cookie, "POST", "/settings/extension-keys")).json().secret as string;
    const [failing, passing, repassed, unscanned, unknown] = [mint(), mint(), mint(), mint(), mint()];
    mints.push(failing, passing, repassed, unscanned, unknown);
    const scan = async (m: string, passed: boolean[], reasons: string[] = []) => {
      const token = await prisma.token.create({ data: { mintAddress: m } });
      for (const [i, ok] of passed.entries()) {
        await prisma.tokenSnapshot.create({
          data: {
            tokenId: token.id,
            priceUsd: 0.00001,
            marketCapUsd: 9_000,
            rugScreenPassed: ok,
            rugScreenReasons: ok ? [] : reasons,
            takenAt: new Date(Date.now() - (passed.length - i) * 60_000),
          },
        });
      }
    };
    await scan(failing, [true, false], ["top 10 holders own 52%"]);
    await scan(passing, [true]);
    // A coin that failed and passed again shows again.
    await scan(repassed, [false, true], ["mint authority active"]);
    await scan(unscanned, []);

    const res = await ext(key, "POST", "/ext/v1/safety", {
      mints: [failing, passing, repassed, unscanned, unknown, "not-a-mint"],
    });
    expect(res.statusCode).toBe(200);
    const verdicts = res.json().verdicts as Record<string, { passed: boolean; reasons: string[] }>;
    expect(verdicts[failing]).toMatchObject({ passed: false, reasons: ["top 10 holders own 52%"] });
    expect(verdicts[passing]).toMatchObject({ passed: true, reasons: [] });
    expect(verdicts[repassed]).toMatchObject({ passed: true, reasons: [] });
    expect(Object.keys(verdicts).sort()).toEqual([failing, passing, repassed].sort());

    expect((await ext(key, "POST", "/ext/v1/safety", { mints: "x" })).statusCode).toBe(400);
    const tooMany = Array.from({ length: 101 }, () => mint());
    expect((await ext(key, "POST", "/ext/v1/safety", { mints: tooMany })).statusCode).toBe(400);
    expect((await ext(null, "POST", "/ext/v1/safety", { mints: [failing] })).statusCode).toBe(401);
  });

  it("reads a tracked coin's latest bubble map with its totals, and no untracked coin's", async () => {
    const user = await makeUser("bubble", true);
    const key = (await session(user.cookie, "POST", "/settings/extension-keys")).json().secret as string;
    const tracked = mint();
    const lookedUp = mint();
    mints.push(tracked, lookedUp);
    const token = await prisma.token.create({ data: { mintAddress: tracked, symbol: "MAP" } });
    await prisma.tokenSnapshot.create({
      data: {
        tokenId: token.id,
        priceUsd: 0.00001,
        marketCapUsd: 9_000,
        linkedWalletPct: 9,
        linkedWalletCount: 2,
        linkedWalletsChecked: 25,
        kolBundledPct: 0,
        cexFundedPct: 5,
        cexFundedCount: 1,
        cexFundedHolders: 20,
        linkedHolders: [
          { wallet: "w1", pct: 5, sniper: true },
          { wallet: "w2", pct: 4 },
          { wallet: "w3", pct: 2, cexFunder: "ex" },
        ],
        linkedClusters: [
          {
            funder: "f1",
            wallets: [
              { wallet: "w1", pct: 5 },
              { wallet: "w2", pct: 4 },
            ],
            pct: 9,
            creatorLinked: false,
          },
        ],
      },
    });
    // Only looked up by someone else: the site gates it, and so does the panel.
    await prisma.token.create({
      data: { mintAddress: lookedUp, symbol: "PAID", discoverySource: "utility" },
    });

    const res = await ext(key, "GET", `/ext/v1/bubble/${tracked}`);
    expect(res.statusCode).toBe(200);
    const { map } = res.json() as {
      map: { holders: { wallet: string; cluster: number | null }[]; totals: Record<string, unknown> };
    };
    expect(map.holders.map((h) => [h.wallet, h.cluster])).toEqual([
      ["w1", 0],
      ["w2", 0],
      ["w3", null],
    ]);
    expect(map.totals).toMatchObject({
      linkedPct: 9,
      linkedCount: { count: 2, of: 25 },
      cexFundedCount: { count: 1, of: 20 },
    });
    expect((await ext(key, "GET", `/ext/v1/bubble/${lookedUp}`)).statusCode).toBe(404);
    expect((await ext(key, "GET", "/ext/v1/bubble/not-a-mint")).statusCode).toBe(400);
  });

  it("replays the site map's reads as the key's owner, and refuses every other site route", async () => {
    const user = await makeUser("site", true);
    const key = (await session(user.cookie, "POST", "/settings/extension-keys")).json().secret as string;
    const coin = mint();
    mints.push(coin);
    await prisma.token.create({ data: { mintAddress: coin, symbol: "SITE" } });
    const site = (method: string, path: string, body: string | null = null) =>
      ext(key, "POST", "/ext/v1/site", { method, path, body });

    // The same answer the owner's signed-in token view gets.
    const reading = await site("GET", `/tokens/${coin}?reading=1`);
    expect(reading.statusCode).toBe(200);
    const direct = await session(user.cookie, "GET", `/tokens/${coin}?reading=1`);
    expect(reading.json().status).toBe(direct.statusCode);
    expect(JSON.parse(reading.json().body as string)).toEqual(direct.json());
    const names = await site("POST", "/wallets/names", JSON.stringify({ wallets: [] }));
    expect(names.statusCode).toBe(200);
    expect(names.json().status).toBeLessThan(500);

    for (const [method, path] of [
      ["GET", "/auth/me"],
      ["GET", "/settings/extension-keys"],
      ["POST", "/settings/extension-keys"],
      ["GET", `/tokens/${coin}?reading=1&x=1`],
      ["GET", `/tokens/${coin}/card/../../auth/me`],
      ["DELETE", `/tokens/${coin}/card`],
      ["POST", `/pro/trade/build`],
    ] as const) {
      expect((await site(method, path, method === "GET" ? null : "{}")).statusCode).toBe(403);
    }
    // A key is still needed.
    expect(
      (await ext(null, "POST", "/ext/v1/site", { method: "GET", path: `/tokens/${coin}/card` })).statusCode,
    ).toBe(401);
  });

  it("keeps an open map's coin viewed and answers its wait when a reading is written", async () => {
    const user = await makeUser("bubble-live", true);
    const key = (await session(user.cookie, "POST", "/settings/extension-keys")).json().secret as string;
    const open = mint();
    mints.push(open);
    const token = await prisma.token.create({ data: { mintAddress: open, symbol: "LIVE" } });
    await prisma.tokenSnapshot.create({
      data: { tokenId: token.id, priceUsd: 0.00001, marketCapUsd: 9_000 },
    });

    expect((await ext(key, "GET", `/ext/v1/bubble/${open}`)).statusCode).toBe(200);
    // Stamped as viewed (written in the background), so the scan keeps reading it out of band.
    await vi.waitFor(
      async () => {
        const row = await prisma.token.findUniqueOrThrow({ where: { id: token.id } });
        expect(row.lastViewedAt).not.toBeNull();
      },
      { timeout: 12_000, interval: 250 },
    );

    expect((await ext(key, "GET", "/ext/v1/bubble/not-a-mint/wait")).statusCode).toBe(400);
    let answered = false;
    const waiting = ext(key, "GET", `/ext/v1/bubble/${open}/wait`).then((res) => {
      answered = true;
      return res;
    });
    // Announced until the API's LISTEN connection hears one.
    await vi.waitFor(
      async () => {
        await notifyHolderReadingWritten(open);
        expect(answered).toBe(true);
      },
      { timeout: 15_000, interval: 300 },
    );
    const res = await waiting;
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ changed: true, pushed: true });
  }, 40_000);

  it("lists the wallet's own coins for Trade Buddy, with their PnL and card", async () => {
    const user = await makeUser("buddy", true);
    const key = (await session(user.cookie, "POST", "/settings/extension-keys")).json().secret as string;
    const bought = mint();
    mints.push(bought);
    const token = await prisma.token.create({
      data: { mintAddress: bought, symbol: "BUDDY", livePriceUsd: 0.002 },
    });
    await prisma.tokenSnapshot.create({
      data: { tokenId: token.id, priceUsd: 0.002, marketCapUsd: 2_000_000 },
    });
    const wallet = `${TAG}-buddy`;
    await prisma.proTrade.create({
      data: {
        wallet,
        signature: `${TAG}-sig-buddy`,
        mint: bought,
        side: "buy",
        lamports: -1_000_000_000n,
        tokens: 1_000_000_000n,
        decimals: 6,
        at: new Date(Date.now() - 60_000),
        entry: true,
      },
    });
    try {
      const res = await ext(key, "GET", "/ext/v1/buddy");
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        coins: { mint: string; held: number; closed: boolean; token: { symbol: string } | null }[];
        pro: boolean;
      };
      const coin = body.coins.find((c) => c.mint === bought);
      expect(coin).toMatchObject({ held: 1000, closed: false });
      expect(coin!.token?.symbol).toBe("BUDDY");
      expect(body.pro).toBe(false);
      // A poll right after is answered from the last read, not read again.
      const again = (await ext(key, "GET", "/ext/v1/buddy")).json() as { readAt: string };
      expect(again.readAt).toBe((body as unknown as { readAt: string }).readAt);
      // A coin the wallet traded opens its map, as the TRADES panel's card opens it on the site.
      expect((await ext(key, "GET", `/ext/v1/bubble/${bought}`)).statusCode).toBe(200);
    } finally {
      await prisma.proTrade.deleteMany({ where: { wallet } });
    }
  });

  it("saves and reads overlay settings, and refuses a bad shape", async () => {
    const user = await makeUser("settings", true);
    const key = (await session(user.cookie, "POST", "/settings/extension-keys")).json().secret as string;
    const me = await ext(key, "GET", "/ext/v1/me");
    expect(me.statusCode).toBe(200);
    expect(me.json().settings).toEqual(DEFAULT_OVERLAY_SETTINGS);
    expect(me.json().wallet).toMatch(/…/);

    const next = { ...DEFAULT_OVERLAY_SETTINGS, style: { ring: "rail", calmMotion: true } };
    expect((await ext(key, "PUT", "/ext/v1/settings", next)).statusCode).toBe(200);
    expect((await ext(key, "GET", "/ext/v1/settings")).json()).toEqual(next);
    expect((await ext(key, "PUT", "/ext/v1/settings", { ...next, extra: 1 })).statusCode).toBe(400);
  });

  it("keeps the extension's display choices with the account, for a reinstall", async () => {
    const user = await makeUser("look", true);
    const key = (await session(user.cookie, "POST", "/settings/extension-keys")).json().secret as string;
    expect((await ext(key, "GET", "/ext/v1/me")).json().look).toBeNull();
    const look = {
      savedAt: 1_761_400_000_000,
      prefs: { colors: { model: "#112233" }, safety: { mode: "hide" } },
    };
    expect((await ext(key, "PUT", "/ext/v1/look", look)).statusCode).toBe(200);
    // A new key (a reinstall connects afresh) reads them back.
    const again = (await session(user.cookie, "POST", "/settings/extension-keys")).json().secret as string;
    expect((await ext(again, "GET", "/ext/v1/me")).json().look).toEqual(look);
    expect((await ext(key, "PUT", "/ext/v1/look", { savedAt: "x", prefs: {} })).statusCode).toBe(400);
    expect((await ext(key, "PUT", "/ext/v1/look", { savedAt: 1, prefs: [] })).statusCode).toBe(400);
    const huge = { savedAt: 1, prefs: { pad: "x".repeat(40_000) } };
    expect((await ext(key, "PUT", "/ext/v1/look", huge)).statusCode).toBe(413);
  });

  it("stops a revoked key at once, and a key its owner may no longer hold", async () => {
    const user = await makeUser("revoke", true);
    const created = (await session(user.cookie, "POST", "/settings/extension-keys")).json() as {
      id: string;
      secret: string;
    };
    expect((await ext(created.secret, "GET", "/ext/v1/me")).statusCode).toBe(200);
    expect((await session(user.cookie, "DELETE", `/settings/extension-keys/${created.id}`)).statusCode).toBe(
      200,
    );
    expect((await ext(created.secret, "GET", "/ext/v1/me")).statusCode).toBe(401);

    // A key whose owner's subscription ended is cut off on its next check.
    const paid = await makeUser("lapse", true);
    const lapsed = (await session(paid.cookie, "POST", "/settings/extension-keys")).json().secret as string;
    expect((await ext(lapsed, "GET", "/ext/v1/me")).statusCode).toBe(200);
    await prisma.subscription.deleteMany({ where: { userId: paid.id } });
    resetExtensionAuthState();
    expect((await ext(lapsed, "GET", "/ext/v1/me")).statusCode).toBe(403);
  });

  it("revokes the account's extension keys when it signs out everywhere", async () => {
    const user = await makeUser("signout", true);
    const { secret } = (await session(user.cookie, "POST", "/settings/extension-keys")).json() as {
      secret: string;
    };
    expect((await ext(secret, "GET", "/ext/v1/me")).statusCode).toBe(200);
    expect((await session(user.cookie, "POST", "/auth/logout")).statusCode).toBe(200);
    expect((await ext(secret, "GET", "/ext/v1/me")).statusCode).toBe(401);
  });

  it("keeps the Origin check on cookie routes while letting the extension's origin through", async () => {
    const user = await makeUser("origin", true);
    const res = await session(user.cookie, "POST", "/settings/extension-keys", {
      origin: "https://evil.example",
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("origin_not_allowed");
  });

  it("answers an extension's origin with CORS on /ext/v1 only, so it needs no host permission", async () => {
    const origin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
    const preflight = await app.inject({
      method: "OPTIONS",
      url: "/ext/v1/settings",
      headers: {
        origin,
        "access-control-request-method": "PUT",
        "access-control-request-headers": "authorization,content-type",
      },
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers["access-control-allow-origin"]).toBe(origin);
    expect(String(preflight.headers["access-control-allow-methods"])).toContain("PUT");
    expect(preflight.headers["access-control-allow-credentials"]).toBeUndefined();
    expect(preflight.headers["access-control-max-age"]).toBe("7200");
    const refused = await ext(null, "GET", "/ext/v1/me");
    expect(refused.statusCode).toBe(401);
    expect(refused.headers["access-control-allow-origin"]).toBe(origin);
    // The site's own routes still answer only the site's origins.
    const other = await app.inject({ method: "GET", url: "/health", headers: { origin } });
    expect(other.headers["access-control-allow-origin"]).toBeUndefined();
    const notExtension = await app.inject({
      method: "GET",
      url: "/ext/v1/me",
      headers: { origin: "https://evil.example" },
    });
    expect(notExtension.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
