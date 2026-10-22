// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { createHash } from "node:crypto";
import { AccessSource } from "@prisma/client";
import { loadEnv, prisma, type Env } from "@trenchscanner/core";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { createSessionSigner, SESSION_COOKIE_NAME } from "../auth/session.js";
import {
  hashModelAlertKey,
  isModelAlertKeyShape,
  MAX_SOCKETS_PER_KEY,
  MAX_SOCKETS_PER_USER,
  modelAlertKeyAccess,
  modelAlertKeyMatches,
  newModelAlertKey,
} from "../modelAlertKey.js";
import { modelAlertArrivedAfterConnect } from "../modelAlertPayload.js";
import { buildServer } from "../server.js";

describe("model alert key access", () => {
  const at = new Date("2026-10-22T00:00:00Z");

  it("allows admin, whitelist, and a live subscription, and refuses free access", () => {
    expect(modelAlertKeyAccess({ hasAccess: true, expiresAt: null, reason: "admin" })).toBe(true);
    expect(modelAlertKeyAccess({ hasAccess: true, expiresAt: null, reason: "whitelist" })).toBe(true);
    expect(modelAlertKeyAccess({ hasAccess: true, expiresAt: at, reason: "subscription" })).toBe(true);
    expect(modelAlertKeyAccess({ hasAccess: true, expiresAt: at, reason: "free_access" })).toBe(false);
    expect(modelAlertKeyAccess({ hasAccess: false, expiresAt: at, reason: "none" })).toBe(false);
  });

  it("drops an alert timestamped before the socket opened", () => {
    const opened = Date.parse("2026-10-22T12:00:00Z");
    expect(modelAlertArrivedAfterConnect(new Date(opened - 1), opened)).toBe(false);
    expect(modelAlertArrivedAfterConnect(new Date(opened), opened)).toBe(true);
    expect(modelAlertArrivedAfterConnect(new Date(opened + 1), opened)).toBe(true);
  });

  it("rejects a short token and peppers the hash with the server secret", () => {
    const server = "p".repeat(32);
    expect(isModelAlertKeyShape(`tsma_${"a".repeat(11)}`)).toBe(false);
    expect(isModelAlertKeyShape(`tsma_${"a".repeat(43)}`)).toBe(true);
    const minted = newModelAlertKey(server);
    expect(isModelAlertKeyShape(minted.secret)).toBe(true);
    expect(minted.secretHash).not.toBe(createHash("sha256").update(minted.secret).digest("hex"));
    expect(minted.secretHash).toBe(hashModelAlertKey(minted.secret, server));
    expect(modelAlertKeyMatches(minted.secret, minted.secretHash, server)).toBe(true);
    expect(modelAlertKeyMatches(minted.secret, minted.secretHash, "q".repeat(32))).toBe(false);
    expect(modelAlertKeyMatches(minted.secret, "ab", server)).toBe(false);
  });
});

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const TAG = `mak-${Date.now()}`;
const HOLDER_DUMP = "HOLDERDUMP11111111111111111111111111111111";
const FLAGGED_DUMP = "FLAGGEDDUMP111111111111111111111111111111";
const RATIONALE = "NARRATIVE_RATIONALE_SENTINEL_do_not_leak";

describe.skipIf(!dbAvailable)("model alert api keys and socket", () => {
  let app: FastifyInstance;
  let port = 0;
  const signer = createSessionSigner(loadEnv().JWT_SECRET, loadEnv().SESSION_TTL_HOURS);
  const sockets: WebSocket[] = [];
  const closeCodes = new Map<WebSocket, number>();

  const wallet = (suffix: string) => `${TAG}-${suffix}`;

  async function makeUser(suffix: string) {
    const walletAddress = wallet(suffix);
    const row = await prisma.user.create({ data: { walletAddress } });
    const cookie = await signer.sign({ userId: row.id, walletAddress, sessionVersion: 0 });
    return { id: row.id, walletAddress, cookie };
  }

  async function subscribe(userId: string, expiresAt: Date) {
    await prisma.subscription.create({
      data: { userId, expiresAt, source: AccessSource.BURN },
    });
  }

  const call = (cookie: string | null, method: "GET" | "POST" | "DELETE", url: string) =>
    app.inject({
      method,
      url,
      ...(cookie ? { cookies: { [SESSION_COOKIE_NAME]: cookie } } : {}),
    });

  const generate = (cookie: string) => call(cookie, "POST", "/settings/model-alert-keys");

  beforeAll(async () => {
    const adminWallet = wallet("admin");
    const env: Env = { ...loadEnv(), ADMIN_WALLET_ADDRESSES: adminWallet };
    app = await buildServer(env);
    await app.ready();
    await new Promise<void>((resolve, reject) => {
      app.server.once("error", reject);
      app.server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("socket test server has no port");
    port = address.port;

    const admin = await makeUser("admin");
    const listed = await makeUser("whitelist");
    const free = await makeUser("free");
    await prisma.whitelist.create({
      data: { walletAddress: listed.walletAddress, addedBy: admin.walletAddress },
    });
    const period = await prisma.freeAccessPeriod.create({
      data: {
        signInStartsAt: new Date(Date.now() - 60_000),
        signInEndsAt: new Date(Date.now() + 3_600_000),
        accessEndsAt: new Date(Date.now() + 7_200_000),
        createdBy: admin.walletAddress,
      },
    });
    await prisma.freeAccessGrant.create({
      data: {
        periodId: period.id,
        walletAddress: free.walletAddress,
        userId: free.id,
        createdAccount: false,
      },
    });
  }, 60_000);

  afterAll(async () => {
    for (const socket of sockets) socket.terminate();
    await app?.close();
    if (!dbAvailable) return;
    await prisma.token.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
    await prisma.tokenNarrative.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
    await prisma.whitelist.deleteMany({ where: { walletAddress: { startsWith: TAG } } });
    await prisma.freeAccessGrant.deleteMany({ where: { walletAddress: { startsWith: TAG } } });
    await prisma.freeAccessPeriod.deleteMany({ where: { createdBy: { startsWith: TAG } } });
    await prisma.user.deleteMany({ where: { walletAddress: { startsWith: TAG } } });
  }, 30_000);

  it("refuses a signed-out caller", async () => {
    const res = await call(null, "POST", "/settings/model-alert-keys");
    expect(res.statusCode).toBe(401);
  });

  it("refuses free access and a wallet with no access, including a lapsed burn", async () => {
    const free = await prisma.user.findUniqueOrThrow({ where: { walletAddress: wallet("free") } });
    const freeCookie = await signer.sign({
      userId: free.id,
      walletAddress: free.walletAddress,
      sessionVersion: 0,
    });
    const freeRes = await generate(freeCookie);
    expect(freeRes.statusCode).toBe(403);
    expect(freeRes.json().error).toMatch(/Free access/);
    expect(await prisma.userApiKey.count({ where: { userId: free.id } })).toBe(0);

    const none = await makeUser("none");
    const noneRes = await generate(none.cookie);
    expect(noneRes.statusCode).toBe(403);
    expect(noneRes.json().error).toMatch(/paid subscription/);

    const lapsed = await makeUser("lapsed");
    await subscribe(lapsed.id, new Date(Date.now() - 60_000));
    const lapsedRes = await generate(lapsed.cookie);
    expect(lapsedRes.statusCode).toBe(403);
  });

  it("issues a key for a paid burn, an admin, and a whitelist entry, and lists the prefix only", async () => {
    const paid = await makeUser("paid");
    await subscribe(paid.id, new Date(Date.now() + 86_400_000));
    const created = await generate(paid.cookie);
    expect(created.statusCode).toBe(200);
    const body = created.json() as { id: string; prefix: string; secret: string };
    expect(body.secret).toMatch(/^tsma_/);
    expect(body.prefix).toBe(body.secret.slice(0, 12));
    expect(body.prefix.length).toBeLessThan(body.secret.length);

    const stored = await prisma.userApiKey.findUniqueOrThrow({ where: { id: body.id } });
    expect(stored.secretHash).not.toContain(body.secret);
    expect(JSON.stringify(stored)).not.toContain(body.secret);

    const list = await call(paid.cookie, "GET", "/settings/model-alert-keys");
    expect(list.statusCode).toBe(200);
    const listed = list.json() as { keys: { id: string; prefix: string; secret?: string }[]; limit: number };
    expect(listed.limit).toBe(3);
    expect(listed.keys).toEqual([expect.objectContaining({ id: body.id, prefix: body.prefix })]);
    expect(JSON.stringify(listed)).not.toContain(body.secret);
    expect(listed.keys[0]?.secret).toBeUndefined();

    const admin = await prisma.user.findUniqueOrThrow({ where: { walletAddress: wallet("admin") } });
    const adminCookie = await signer.sign({
      userId: admin.id,
      walletAddress: admin.walletAddress,
      sessionVersion: 0,
    });
    expect((await generate(adminCookie)).statusCode).toBe(200);

    const listedUser = await prisma.user.findUniqueOrThrow({ where: { walletAddress: wallet("whitelist") } });
    const listedCookie = await signer.sign({
      userId: listedUser.id,
      walletAddress: listedUser.walletAddress,
      sessionVersion: 0,
    });
    expect((await generate(listedCookie)).statusCode).toBe(200);
  });

  it("rejects a fourth active key and lets a revoked key's slot be used again", async () => {
    const user = await makeUser("capped");
    await subscribe(user.id, new Date(Date.now() + 86_400_000));
    const secrets: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const res = await generate(user.cookie);
      expect(res.statusCode, `key ${i}`).toBe(200);
      secrets.push((res.json() as { secret: string }).secret);
    }
    const fourth = await generate(user.cookie);
    expect(fourth.statusCode).toBe(409);
    expect(fourth.json().error).toMatch(/3/);
    expect(await prisma.userApiKey.count({ where: { userId: user.id, revokedAt: null } })).toBe(3);

    const keys = await prisma.userApiKey.findMany({ where: { userId: user.id }, select: { id: true } });
    const revoked = await call(user.cookie, "DELETE", `/settings/model-alert-keys/${keys[0]!.id}`);
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json().revokedAt).toBeTruthy();
    expect((await generate(user.cookie)).statusCode).toBe(200);

    const stranger = await makeUser("stranger");
    await subscribe(stranger.id, new Date(Date.now() + 86_400_000));
    expect(
      (await call(stranger.cookie, "DELETE", `/settings/model-alert-keys/${keys[1]!.id}`)).statusCode,
    ).toBe(404);
    // The revoked secret is what the socket test uses below.
    expect(secrets[0]).toMatch(/^tsma_/);
  });

  it("sends a curated alert that arrives after connect, and not one from before or a revoked key", async () => {
    const user = await makeUser("socket");
    await subscribe(user.id, new Date(Date.now() + 86_400_000));
    const created = await generate(user.cookie);
    expect(created.statusCode).toBe(200);
    const secret = (created.json() as { secret: string }).secret;
    const revokedKey = await generate(user.cookie);
    const revokedSecret = (revokedKey.json() as { id: string; secret: string }).secret;
    const revokedId = (revokedKey.json() as { id: string }).id;
    expect((await call(user.cookie, "DELETE", `/settings/model-alert-keys/${revokedId}`)).statusCode).toBe(
      200,
    );

    await expect(connect(revokedSecret)).rejects.toThrow(/401/);

    const mint = `${TAG}-mint`;
    const token = await prisma.token.create({
      data: {
        mintAddress: mint,
        symbol: "MALT",
        name: "Model Alert",
        imageUrl: "https://example.test/malt.png",
        twitterUrl: "https://x.com/malt",
        websiteUrl: "https://malt.example",
        aiTextScores: { copycatRisk: 0.1, narrativeStrength: 0.8, memeAppeal: 0.7, scamSignals: 0.05 },
        liveMarketCapUsd: 80_000,
        liveDataAt: new Date(),
      },
    });
    const snapshot = await prisma.tokenSnapshot.create({
      data: {
        tokenId: token.id,
        priceUsd: 0.0002,
        marketCapUsd: 40_000,
        top10HolderPct: 22,
        devWalletPct: 1.5,
        freshTop10WalletPct: 11,
        linkedWalletPct: 4,
        linkedHolders: [{ wallet: HOLDER_DUMP, pct: 9 }],
        flaggedTrades: [{ wallet: FLAGGED_DUMP, side: "buy", sol: 1.2 }],
      },
    });
    await prisma.tokenNarrative.create({
      data: {
        mintAddress: mint,
        depth: "basic",
        status: "ok",
        feeDestination: "holder_rewards",
        feeSummary: "Fees pay holders",
        feeCreatorBps: 100,
      },
    });
    const old = await prisma.curatedAlert.create({
      data: {
        tokenId: token.id,
        snapshotId: snapshot.id,
        source: "test",
        model: "trees",
        modelName: "Trees",
        confidence: 81,
        tier: "standard",
        calibratedPct: 20,
        reasons: ["old call"],
        anchorPriceUsd: 0.0002,
        anchorMcapUsd: 40_000,
        narrativeRationale: { note: RATIONALE },
        createdAt: new Date(Date.now() - 3_600_000),
      },
    });

    const ws = await connect(secret);
    const messages: string[] = [];
    ws.on("message", (data) => messages.push(String(data)));

    app.matchStream.dispatchCurated(JSON.stringify({ alertId: old.id, model: "trees" }));
    app.matchStream.dispatch(JSON.stringify({ userId: user.id, matchId: "match-not-a-model-alert" }));
    await delay(800);
    expect(messages).toEqual([]);

    const fresh = await prisma.curatedAlert.create({
      data: {
        tokenId: token.id,
        snapshotId: snapshot.id,
        source: "test",
        model: "trees",
        modelName: "Sharp Trees",
        confidence: 91,
        tier: "high",
        calibratedPct: 44,
        reasons: ["volume up"],
        anchorPriceUsd: 0.0002,
        anchorMcapUsd: 40_000,
        liveMcapUsd: 42_000,
        narrativeRationale: { note: RATIONALE },
        createdAt: new Date(Date.now() + 60_000),
      },
    });
    app.matchStream.dispatchCurated(JSON.stringify({ alertId: fresh.id, model: "trees" }));
    const arrived = await waitFor(() => messages.length > 0, 5_000);
    expect(arrived).toBe(true);
    await delay(200);
    expect(messages).toHaveLength(1);

    const payload = JSON.parse(messages[0]!) as {
      id: string;
      mint: string;
      modelName: string;
      confidence: number;
      tier: string;
      calibratedPct: number;
      aiTextScores: { narrativeStrength: number };
      fees: { destination: string; bps: number };
      safety: { top10HolderPct: number };
      links: { twitter: string; pumpfun: string };
      image: string;
      caps: { alertMcapUsd: number };
    };
    const raw = messages[0]!;
    expect(payload.id).toBe(fresh.id);
    expect(payload.mint).toBe(mint);
    expect(payload.modelName).toBe("Sharp Trees");
    expect(payload.confidence).toBe(91);
    expect(payload.tier).toBe("high");
    expect(payload.calibratedPct).toBe(44);
    expect(payload.aiTextScores.narrativeStrength).toBe(0.8);
    expect(payload.fees).toMatchObject({ destination: "holder_rewards", bps: 100 });
    expect(payload.safety.top10HolderPct).toBe(22);
    expect(payload.links.twitter).toBe("https://x.com/malt");
    expect(payload.links.pumpfun).toContain(mint);
    expect(payload.image).toBe("https://example.test/malt.png");
    expect(payload.caps.alertMcapUsd).toBe(40_000);
    expect(raw).not.toContain("narrativeRationale");
    expect(raw).not.toContain(RATIONALE);
    expect(raw).not.toContain(HOLDER_DUMP);
    expect(raw).not.toContain(FLAGGED_DUMP);
    expect(raw).not.toContain("linkedHolders");
    expect(raw).not.toContain("flaggedTrades");
    ws.close();
  });

  it("closes the socket on the next alert after the subscription lapses", async () => {
    const user = await makeUser("lapse");
    await subscribe(user.id, new Date(Date.now() + 86_400_000));
    const created = await generate(user.cookie);
    expect(created.statusCode).toBe(200);
    const ws = await connect((created.json() as { secret: string }).secret);
    const messages: string[] = [];
    let closeCode = 0;
    ws.on("message", (data) => messages.push(String(data)));
    ws.on("close", (code) => {
      closeCode = code;
    });
    await prisma.subscription.update({
      where: { userId: user.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    const token = await prisma.token.create({ data: { mintAddress: `${TAG}-lapse` } });
    const alert = await prisma.curatedAlert.create({
      data: {
        tokenId: token.id,
        source: "test",
        model: "trees",
        modelName: "Trees",
        confidence: 50,
        anchorPriceUsd: 1,
        anchorMcapUsd: 1_000,
        createdAt: new Date(Date.now() + 60_000),
      },
    });
    app.matchStream.dispatchCurated(JSON.stringify({ alertId: alert.id, model: "trees" }));
    expect(await waitFor(() => closeCode !== 0, 5_000)).toBe(true);
    expect(closeCode).toBe(4403);
    expect(messages).toEqual([]);
  });

  it("stores a peppered hash, not a bare SHA-256 of the secret", async () => {
    const user = await makeUser("pepper");
    await subscribe(user.id, new Date(Date.now() + 86_400_000));
    const created = await generate(user.cookie);
    expect(created.statusCode).toBe(200);
    const secret = (created.json() as { secret: string }).secret;
    const stored = await prisma.userApiKey.findFirstOrThrow({
      where: { userId: user.id, revokedAt: null },
    });
    expect(stored.secretHash).not.toBe(createHash("sha256").update(secret).digest("hex"));
    expect(stored.secretHash).toBe(hashModelAlertKey(secret, loadEnv().JWT_SECRET));
    expect(stored.secretHash).not.toContain(secret);
    expect(secret.startsWith("tsma_")).toBe(true);
    expect(secret.length).toBe(48);
  });

  it("rejects a short key and a full-length key stored as a bare SHA-256", async () => {
    const user = await makeUser("weakhash");
    await subscribe(user.id, new Date(Date.now() + 86_400_000));
    const short = `tsma_${"a".repeat(11)}`;
    const full = `tsma_${"b".repeat(43)}`;
    await prisma.userApiKey.createMany({
      data: [short, full].map((secret) => ({
        userId: user.id,
        prefix: secret.slice(0, 12),
        secretHash: createHash("sha256").update(secret).digest("hex"),
      })),
    });
    await expect(connect(short)).rejects.toThrow(/401/);
    await expect(connect(full)).rejects.toThrow(/401/);
  });

  it("refuses a fourth generate with 409 and the next ones with 429", async () => {
    const user = await makeUser("flood");
    await subscribe(user.id, new Date(Date.now() + 86_400_000));
    const codes: number[] = [];
    for (let i = 0; i < 9; i += 1) codes.push((await generate(user.cookie)).statusCode);
    expect(codes.slice(0, 3)).toEqual([200, 200, 200]);
    expect(codes).toContain(409);
    expect(codes).toContain(429);
    expect(await prisma.userApiKey.count({ where: { userId: user.id, revokedAt: null } })).toBe(3);
  });

  it("refuses to generate a key from a cross-site origin", async () => {
    const user = await makeUser("csrf");
    await subscribe(user.id, new Date(Date.now() + 86_400_000));
    const forged = await app.inject({
      method: "POST",
      url: "/settings/model-alert-keys",
      headers: { origin: "https://evil.example" },
      cookies: { [SESSION_COOKIE_NAME]: user.cookie },
    });
    expect(forged.statusCode).toBe(403);
    expect(forged.json().error).toBe("origin_not_allowed");
    expect(await prisma.userApiKey.count({ where: { userId: user.id } })).toBe(0);

    const allowed = loadEnv().CORS_ORIGINS.split(",")[0]!.trim();
    const own = await app.inject({
      method: "POST",
      url: "/settings/model-alert-keys",
      headers: { origin: allowed },
      cookies: { [SESSION_COOKIE_NAME]: user.cookie },
    });
    expect(own.statusCode).toBe(200);
  });

  it("caps concurrent sockets for one key", async () => {
    const user = await makeUser("sockcap");
    await subscribe(user.id, new Date(Date.now() + 86_400_000));
    const secret = ((await generate(user.cookie)).json() as { secret: string }).secret;
    const open: WebSocket[] = [];
    for (let i = 0; i < MAX_SOCKETS_PER_KEY; i += 1) open.push(await connect(secret));
    expect(open.every((ws) => ws.readyState === WebSocket.OPEN)).toBe(true);
    const extra = await connect(secret);
    expect(await waitFor(() => closeCodeOf(extra) === 4429, 1_500)).toBe(true);
    expect(open[0]!.readyState).toBe(WebSocket.OPEN);
  });

  it("caps concurrent sockets for one user across keys", async () => {
    const user = await makeUser("usercap");
    await subscribe(user.id, new Date(Date.now() + 86_400_000));
    const keysNeeded = Math.ceil((MAX_SOCKETS_PER_USER + 1) / MAX_SOCKETS_PER_KEY);
    expect(keysNeeded).toBeLessThanOrEqual(3);
    const secrets: string[] = [];
    for (let i = 0; i < keysNeeded; i += 1) {
      const res = await generate(user.cookie);
      expect(res.statusCode).toBe(200);
      secrets.push((res.json() as { secret: string }).secret);
    }
    const open: WebSocket[] = [];
    let left = MAX_SOCKETS_PER_USER;
    for (let i = 0; i < secrets.length - 1; i += 1) {
      const take = Math.min(MAX_SOCKETS_PER_KEY, left);
      for (let n = 0; n < take; n += 1) open.push(await connect(secrets[i]!));
      left -= take;
    }
    expect(open.every((ws) => ws.readyState === WebSocket.OPEN)).toBe(true);
    const extra = await connect(secrets[secrets.length - 1]!);
    expect(await waitFor(() => closeCodeOf(extra) === 4429, 1_500)).toBe(true);
  });

  it("closes a live socket when its key is revoked and drops a later alert", async () => {
    const user = await makeUser("revoke-live");
    await subscribe(user.id, new Date(Date.now() + 86_400_000));
    const created = await generate(user.cookie);
    expect(created.statusCode).toBe(200);
    const body = created.json() as { id: string; secret: string };
    const ws = await connect(body.secret);
    const messages: string[] = [];
    ws.on("message", (data) => messages.push(String(data)));
    expect((await call(user.cookie, "DELETE", `/settings/model-alert-keys/${body.id}`)).statusCode).toBe(200);
    expect(await waitFor(() => closeCodeOf(ws) === 4401, 2_000)).toBe(true);

    const token = await prisma.token.create({ data: { mintAddress: `${TAG}-revoke-live` } });
    const alert = await prisma.curatedAlert.create({
      data: {
        tokenId: token.id,
        source: "test",
        model: "trees",
        modelName: "Trees",
        confidence: 50,
        anchorPriceUsd: 1,
        anchorMcapUsd: 1_000,
        narrativeRationale: { note: RATIONALE },
        createdAt: new Date(Date.now() + 60_000),
      },
    });
    app.matchStream.dispatchCurated(JSON.stringify({ alertId: alert.id, model: "trees" }));
    await delay(400);
    expect(messages).toEqual([]);
    expect(messages.join("")).not.toContain(RATIONALE);
  });

  it("closes a socket that sends an oversized frame and does not log or echo it", async () => {
    const user = await makeUser("oversize");
    await subscribe(user.id, new Date(Date.now() + 86_400_000));
    const secret = ((await generate(user.cookie)).json() as { secret: string }).secret;
    const ws = await connect(secret);
    const lines: string[] = [];
    const warn = console.warn;
    const error = console.error;
    console.warn = (line?: unknown) => {
      lines.push(String(line));
    };
    console.error = (line?: unknown) => {
      lines.push(String(line));
    };
    const sentinel = `OVERFLOW_${"z".repeat(4_000)}`;
    try {
      ws.send(sentinel);
      expect(await waitFor(() => closeCodeOf(ws) !== 0, 2_000)).toBe(true);
    } finally {
      console.warn = warn;
      console.error = error;
    }
    expect(lines.join("\n")).not.toContain(sentinel);
    expect(lines.join("\n")).not.toContain(secret);
  });

  it("does not deliver alerts to a socket that put the key only in the query string", async () => {
    const user = await makeUser("queryonly");
    await subscribe(user.id, new Date(Date.now() + 86_400_000));
    const secret = ((await generate(user.cookie)).json() as { secret: string }).secret;
    const ws = await connect(secret, "query");
    const messages: string[] = [];
    ws.on("message", (data) => messages.push(String(data)));
    const token = await prisma.token.create({ data: { mintAddress: `${TAG}-queryonly` } });
    const alert = await prisma.curatedAlert.create({
      data: {
        tokenId: token.id,
        source: "test",
        model: "trees",
        modelName: "Trees",
        confidence: 50,
        anchorPriceUsd: 1,
        anchorMcapUsd: 1_000,
        createdAt: new Date(Date.now() + 60_000),
      },
    });
    app.matchStream.dispatchCurated(JSON.stringify({ alertId: alert.id, model: "trees" }));
    await delay(800);
    expect(messages).toEqual([]);
    ws.close();
  });

  it("accepts the key as the first frame and does not copy that frame into an alert", async () => {
    const user = await makeUser("frame");
    await subscribe(user.id, new Date(Date.now() + 86_400_000));
    const secret = ((await generate(user.cookie)).json() as { secret: string }).secret;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/model-alerts`);
    sockets.push(ws);
    const messages: string[] = [];
    ws.on("message", (data) => messages.push(String(data)));
    await opened(ws);
    const echoed = "CLIENT_FRAME_SENTINEL_do_not_echo";
    ws.send(JSON.stringify({ key: secret, narrativeRationale: echoed }));
    await delay(400);
    const token = await prisma.token.create({ data: { mintAddress: `${TAG}-frame` } });
    const alert = await prisma.curatedAlert.create({
      data: {
        tokenId: token.id,
        source: "test",
        model: "trees",
        modelName: "Trees",
        confidence: 61,
        anchorPriceUsd: 1,
        anchorMcapUsd: 2_000,
        narrativeRationale: { note: RATIONALE },
        createdAt: new Date(Date.now() + 60_000),
      },
    });
    app.matchStream.dispatchCurated(JSON.stringify({ alertId: alert.id, model: "trees" }));
    expect(await waitFor(() => messages.length > 0, 5_000)).toBe(true);
    expect(messages).toHaveLength(1);
    expect(messages[0]).not.toContain(echoed);
    expect(messages[0]).not.toContain(RATIONALE);
    expect(messages[0]).not.toContain(secret);
    ws.close();
  });

  it("accepts the key in the X-Api-Key header", async () => {
    const user = await makeUser("xapi");
    await subscribe(user.id, new Date(Date.now() + 86_400_000));
    const secret = ((await generate(user.cookie)).json() as { secret: string }).secret;
    const ws = await connect(secret, "api-key");
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it("bounds failed key guesses", async () => {
    const secret = `tsma_${"c".repeat(43)}`;
    const codes: number[] = [];
    for (let i = 0; i < 31; i += 1) {
      try {
        await connect(secret, "header");
        codes.push(101);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const match = /status (\d+)/.exec(msg);
        codes.push(match ? Number(match[1]) : 0);
      }
    }
    expect(codes).toContain(429);
    expect(codes).not.toContain(101);
  });

  it("refuses only the guessing address, and never a live key", async () => {
    // The previous test left this address over the cap.
    const guess = `tsma_${"c".repeat(43)}`;
    await expect(connect(guess, "header")).rejects.toThrow("status 429");
    // Another address with a wrong key is told it is wrong, not that there were too many.
    await expect(connect(guess, "header", "203.0.113.9")).rejects.toThrow("status 401");

    const user = await makeUser("locked-out-ip");
    await subscribe(user.id, new Date(Date.now() + 86_400_000));
    const secret = ((await generate(user.cookie)).json() as { secret: string }).secret;
    const ws = await connect(secret, "header");
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();

    // The first-frame path too: a live key connects, and a wrong one is refused as too many.
    const framed = new WebSocket(`ws://127.0.0.1:${port}/v1/model-alerts`);
    sockets.push(framed);
    let framedCode = 0;
    framed.on("close", (code) => (framedCode = code));
    await opened(framed);
    framed.send(secret);
    await delay(400);
    expect(framed.readyState).toBe(WebSocket.OPEN);
    framed.close();
    const wrong = new WebSocket(`ws://127.0.0.1:${port}/v1/model-alerts`);
    sockets.push(wrong);
    const closed = new Promise<number>((resolve) => wrong.once("close", (code) => resolve(code)));
    await opened(wrong);
    wrong.send(guess);
    expect(await closed).toBe(4429);
    expect(framedCode).not.toBe(4429);
  });

  // Last in the describe: a Prisma spy, restored or not, leaves no working method behind.
  it("closes a first-frame socket with 1011 when the key check fails on the database", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/model-alerts`);
    sockets.push(ws);
    const closed = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));
    await opened(ws);
    vi.spyOn(prisma.userApiKey, "findUnique").mockRejectedValue(new Error("pool exhausted"));
    // This address is over the failure cap after the tests above; the key is still looked up.
    ws.send(`tsma_${"d".repeat(43)}`);
    expect(await closed).toBe(1011);
  });

  function connect(
    secret: string,
    transport: "header" | "query" | "api-key" = "header",
    address?: string,
  ): Promise<WebSocket> {
    const query = transport === "query" ? `?key=${encodeURIComponent(secret)}` : "";
    const headers: Record<string, string> = address ? { "cf-connecting-ip": address } : {};
    if (transport === "header") headers.authorization = `Bearer ${secret}`;
    if (transport === "api-key") headers["x-api-key"] = secret;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/model-alerts${query}`, { headers });
    sockets.push(ws);
    closeCodes.set(ws, 0);
    ws.on("close", (code) => closeCodes.set(ws, code));
    return opened(ws);
  }

  function closeCodeOf(ws: WebSocket): number {
    return closeCodes.get(ws) ?? 0;
  }
});

function opened(ws: WebSocket): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error("open timeout"));
    }, 4_000);
    ws.once("open", () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.once("unexpected-response", (_req, res) => {
      clearTimeout(timer);
      reject(new Error(`status ${res.statusCode}`));
    });
    ws.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(ready: () => boolean, ms: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (ready()) return true;
    await delay(20);
  }
  return ready();
}
