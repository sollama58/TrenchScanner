// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { createHash, randomBytes } from "node:crypto";
import bs58 from "bs58";
import { AccessSource } from "@prisma/client";
import { loadEnv, prisma, type Env } from "@trenchscanner/core";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
  const env: Env = dbAvailable ? loadEnv() : (undefined as never);
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

  it("never reads a session cookie on /ext/v1", async () => {
    const user = await makeUser("cookie", true);
    const res = await app.inject({
      method: "GET",
      url: "/ext/v1/me",
      cookies: { [SESSION_COOKIE_NAME]: user.cookie },
    });
    expect(res.statusCode).toBe(401);
  });

  it("looks up visible mints from the database: alerts, followed calls, AI verdict and flags", async () => {
    const user = await makeUser("lookup", true);
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

    const res = await ext(key, "POST", "/ext/v1/lookup", {
      mints: [trackedMint, untrackedMint, "GPs…pump", trackedMint],
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      tokens: {
        mint: string;
        stats: Record<string, unknown>;
        modelCalls: { model: string; calibratedPct: number }[];
        filterMatches: { filterName: string }[];
        ai: { decision: string; reasoning: string };
      }[];
      untracked: string[];
    };
    expect(body.untracked).toEqual([untrackedMint]);
    expect(body.tokens).toHaveLength(1);
    const [t] = body.tokens;
    expect(t!.mint).toBe(trackedMint);
    expect(t!.stats).toMatchObject({ marketCapUsd: 6_100, bundledSupplyPct: 2, linkedWalletPct: 14 });
    expect(t!.filterMatches.map((m) => m.filterName)).toEqual(["Clean launch"]);
    expect(t!.modelCalls.map((c) => c.model)).toEqual(["rules"]);
    expect(t!.ai.decision).toBe("buy");
    expect(t!.ai.reasoning.length).toBe(280);

    // Another reader shares the cached token half but never sees this reader's filter match.
    const other = await makeUser("other", true);
    const otherKey = (await session(other.cookie, "POST", "/settings/extension-keys")).json()
      .secret as string;
    const otherRes = await ext(otherKey, "POST", "/ext/v1/lookup", { mints: [trackedMint] });
    expect(otherRes.json().tokens[0].filterMatches).toEqual([]);

    expect((await ext(key, "POST", "/ext/v1/lookup", { mints: [] })).statusCode).toBe(400);
    expect(
      (await ext(key, "POST", "/ext/v1/lookup", { mints: Array.from({ length: 101 }, mint) })).statusCode,
    ).toBe(400);
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

  it("stops a revoked key at once, and a key whose access lapsed", async () => {
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

    const lapsing = await makeUser("lapse", true);
    const live = (await session(lapsing.cookie, "POST", "/settings/extension-keys")).json() as {
      secret: string;
    };
    await prisma.subscription.update({
      where: { userId: lapsing.id },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });
    resetExtensionAuthState();
    expect((await ext(live.secret, "GET", "/ext/v1/me")).statusCode).toBe(403);
  });

  it("keeps the Origin check on cookie routes while letting the extension's origin through", async () => {
    const user = await makeUser("origin", true);
    const res = await session(user.cookie, "POST", "/settings/extension-keys", {
      origin: "https://evil.example",
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("origin_not_allowed");
  });
});
