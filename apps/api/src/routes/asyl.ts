import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { prisma, withApiFeature, type Env, type HeliusClient } from "@trenchscanner/core";
import { loadWalletProfile, type WalletLiveReader } from "../walletProfile.js";
import type { WalletIdentityReader } from "../walletIdentity.js";
import { proStatus } from "../proMode.js";
import {
  activeTracked,
  cleanTrackedName,
  listTracked,
  platformLabels,
  removeTracked,
  saveTracked,
  TRACKED_NAME_MAX,
  TRACKED_WALLET_CAP,
  type TrackedWallet,
} from "../trackedWallets.js";
import {
  addCoins,
  addCoTraders,
  addFunding,
  addHolders,
  addHolderTransfers,
  addSides,
  decorate,
  GraphBuilder,
  loadCoTraders,
  loadStoredHolders,
  STORED_DAYS,
} from "../asyl/graph.js";
import { labelsGraph, loadSimilarCoins } from "../asyl/similar.js";
import { readAllowance } from "../asyl/credits.js";
import {
  addFlows,
  readFunders,
  readTokenHolders,
  readWalletFlows,
  type ChainRefusal,
} from "../asyl/chain.js";
import {
  createMap,
  deleteMap,
  listMaps,
  MAP_BODY_LIMIT,
  MAPS_PER_USER,
  readMap,
  readShared,
  saveSchema,
  shareMap,
  unshareMap,
  updateMap,
} from "../asyl/maps.js";
import type { AsylCoverage } from "../asyl/types.js";

/**
 * Asyl (asyl.trenchscanner.app, user decisions 2026-10-24): maps of how wallets are linked, for
 * every signed-in user from TrenchScanner's own tables, with chain reads for Pro Mode under a daily
 * credit allowance (asyl/credits.ts). The reader's own wallet labels lay over every name while
 * they have Pro Mode, and can be added and edited here. Saved maps can be shared as read-only
 * snapshots: GET /asyl/shared/:slug is the one route that needs no session.
 *
 * Signed in, not paid: authenticate rather than the dashboard's authenticateSubscriber.
 */

const address = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "not a Solana address");
const walletParams = z.object({ wallet: address });
const mintParams = z.object({ mint: address });
const idParams = z.object({ id: z.string().min(1).max(40) });
const slugParams = z.object({ slug: z.string().regex(/^[A-Za-z0-9]{8,24}$/) });
const labelBody = z.object({
  name: z
    .string()
    .min(1)
    .max(TRACKED_NAME_MAX * 4),
  kol: z.boolean().default(false),
});
const fundersBody = z.object({ wallets: z.array(address).min(1).max(20) });

/** Each map read is a handful of indexed queries: well above what a person clicks. */
const READ_LIMIT = { max: 60, timeWindow: "1 minute" };
/** Chain reads also wait on the allowance; this only stops a script. */
const CHAIN_LIMIT = { max: 12, timeWindow: "1 minute" };
const WRITE_LIMIT = { max: 30, timeWindow: "1 minute" };
/** Public snapshots, per IP. */
const SHARED_LIMIT = { max: 60, timeWindow: "1 minute" };

function bad(reply: FastifyReply, err: z.ZodError) {
  return reply.code(400).send({ error: err.issues[0]?.message ?? "invalid request" });
}

/** A refused chain read, as the web app shows it. */
function refusal(reply: FastifyReply, r: ChainRefusal) {
  switch (r.refused) {
    case "not-pro":
      return reply.code(403).send({ error: "Chain reads need Pro Mode", code: "not_pro" });
    case "allowance":
      return reply.code(429).send({
        error: "Today's chain-read allowance is used up. It resets at midnight UTC.",
        code: "allowance",
        allowance: r.allowance,
      });
    case "credits-out":
      return reply.code(503).send({ error: "Chain reads are paused for a few minutes.", code: "paused" });
    case "busy":
      return reply.code(409).send({ error: "Another chain read of yours is still running.", code: "busy" });
    case "unavailable":
      return reply
        .code(502)
        .send({ error: "The chain read didn't come back. Try again in a moment.", code: "failed" });
  }
}

export async function registerAsylRoutes(
  app: FastifyInstance,
  opts: {
    env: Env;
    helius: HeliusClient | null;
    live: WalletLiveReader | null;
    identity: WalletIdentityReader | null;
  },
) {
  const { env } = opts;

  // The one public read: a shared map's frozen copy.
  await app.register(async (pub) => {
    pub.get("/shared/:slug", { config: { rateLimit: SHARED_LIMIT } }, async (request, reply) => {
      const p = slugParams.safeParse(request.params);
      if (!p.success) return reply.code(404).send({ error: "No such map" });
      const map = await readShared(p.data.slug);
      if (!map) return reply.code(404).send({ error: "This map isn't shared any more." });
      reply.header("Cache-Control", "public, max-age=60");
      return map;
    });
  });

  await app.register(async (priv) => {
    priv.addHook("preHandler", priv.authenticate);

    const isPro = async (request: FastifyRequest) =>
      !!request.user && (await proStatus(env, request.user.walletAddress).catch(() => null))?.pro === true;
    const trackedOf = (request: FastifyRequest): Promise<TrackedWallet[]> => activeTracked(env, request.user);

    priv.get("/me", async (request) => {
      const pro = await isPro(request);
      return {
        wallet: request.user!.walletAddress,
        pro,
        chain: pro ? await readAllowance(env, request.user!.userId) : null,
        labels: { cap: TRACKED_WALLET_CAP, nameMax: TRACKED_NAME_MAX },
      };
    });

    /** What an address is: a coin TrenchScanner knows, a wallet it has seen, or neither yet. */
    priv.get("/resolve/:wallet", { config: { rateLimit: READ_LIMIT } }, async (request, reply) => {
      const p = walletParams.safeParse(request.params);
      if (!p.success) return bad(reply, p.error);
      const a = p.data.wallet;
      const [token, funder, activity, risk] = await Promise.all([
        prisma.token.findUnique({ where: { mintAddress: a }, select: { symbol: true, name: true } }),
        prisma.walletFunder.findUnique({ where: { wallet: a }, select: { wallet: true } }),
        prisma.tokenWalletActivity.findFirst({ where: { wallet: a }, select: { id: true } }),
        prisma.walletRisk.findUnique({ where: { wallet: a }, select: { wallet: true } }),
      ]);
      if (token) return { kind: "token", known: true, name: token.symbol ? `$${token.symbol}` : token.name };
      return { kind: "wallet", known: !!(funder || activity || risk) };
    });

    /** A wallet's neighbourhood from the tables: funding, transfers, coins, co-traders, sides. */
    priv.get("/wallet/:wallet", { config: { rateLimit: READ_LIMIT } }, async (request, reply) => {
      const p = walletParams.safeParse(request.params);
      if (!p.success) return bad(reply, p.error);
      const wallet = p.data.wallet;
      const tracked = await trackedOf(request);
      const g = new GraphBuilder();
      g.node(wallet, "wallet");
      const [, , seen, coTraders] = await Promise.all([
        addFunding(g, wallet),
        addHolderTransfers(g, wallet),
        addCoins(g, wallet),
        loadCoTraders(wallet),
        addSides(g, wallet, tracked),
      ]);
      addCoTraders(g, wallet, coTraders);
      const pro = await isPro(request);
      const coverage: AsylCoverage = {
        seen,
        days: STORED_DAYS,
        chainAvailable: pro,
        note:
          seen > 0
            ? `Seen in ${seen} coin${seen === 1 ? "" : "s"} TrenchScanner tracked in the last ${STORED_DAYS} days.`
            : `Not seen in any coin TrenchScanner tracked in the last ${STORED_DAYS} days.`,
      };
      reply.header("Cache-Control", "private, no-store");
      return { focus: wallet, graph: await decorate(g, tracked), coverage };
    });

    /** The wallet modal's full read, for the side panel. Pro readers' reads of the chain are metered. */
    priv.get("/wallet/:wallet/dossier", { config: { rateLimit: READ_LIMIT } }, async (request, reply) => {
      const p = walletParams.safeParse(request.params);
      if (!p.success) return bad(reply, p.error);
      const pro = await isPro(request);
      const tracked = await trackedOf(request);
      reply.header("Cache-Control", "private, no-store");
      // Pro: its balance and newest page (1-2 credits, the wallet modal's own cached read).
      return withApiFeature("asyl", () =>
        loadWalletProfile(p.data.wallet, pro ? opts.live : null, null, tracked, request.user!.userId),
      );
    });

    /** Its co-traders, and the coins they bought that it didn't. */
    priv.get("/wallet/:wallet/similar", { config: { rateLimit: READ_LIMIT } }, async (request, reply) => {
      const p = walletParams.safeParse(request.params);
      if (!p.success) return bad(reply, p.error);
      const wallet = p.data.wallet;
      const tracked = await trackedOf(request);
      const coTraders = await loadCoTraders(wallet);
      const coins = await loadSimilarCoins(wallet, coTraders);
      const g = new GraphBuilder();
      g.node(wallet, "wallet");
      addCoTraders(g, wallet, coTraders);
      for (const c of coins) g.node(c.mint, "token");
      const graph = await decorate(g, tracked);
      return { focus: wallet, coTraders, coins, graph };
    });

    /** A coin's holders as TrenchScanner last read them, and what ties them. */
    priv.get("/token/:mint", { config: { rateLimit: READ_LIMIT } }, async (request, reply) => {
      const p = mintParams.safeParse(request.params);
      if (!p.success) return bad(reply, p.error);
      const mint = p.data.mint;
      const tracked = await trackedOf(request);
      const stored = await loadStoredHolders(mint);
      const g = new GraphBuilder();
      g.node(mint, "token");
      await addHolders(g, mint, stored.holders, "stored");
      const creator = await prisma.token.findUnique({
        where: { mintAddress: mint },
        select: { creator: true },
      });
      if (creator?.creator) {
        g.node(creator.creator, "wallet");
        g.edge({
          a: creator.creator,
          b: mint,
          kind: "created",
          weight: 1,
          label: "Launched it",
          source: "stored",
          mint,
        });
      }
      const pro = await isPro(request);
      const coverage: AsylCoverage = {
        seen: stored.holders.length,
        days: STORED_DAYS,
        chainAvailable: pro,
        note:
          stored.holders.length > 0
            ? `Top ${stored.holders.length} holders as TrenchScanner read them${stored.readAt ? ` at ${stored.readAt.toISOString().slice(11, 16)} UTC on ${stored.readAt.toISOString().slice(0, 10)}` : ""}.`
            : "TrenchScanner has no holder reading of this coin.",
      };
      reply.header("Cache-Control", "private, no-store");
      return {
        focus: mint,
        graph: await decorate(g, tracked),
        coverage,
        readAt: stored.readAt?.toISOString() ?? null,
      };
    });

    // ---------- the reader's own labels (Pro Mode) ----------

    priv.get("/labels", async (request) => ({
      pro: await isPro(request),
      cap: TRACKED_WALLET_CAP,
      nameMax: TRACKED_NAME_MAX,
      wallets: await listTracked(request.user!.userId),
    }));

    /** Every labeled wallet on one map, tied wherever the tables tie them. */
    priv.get("/labels/map", { config: { rateLimit: READ_LIMIT } }, async (request) => {
      const tracked = await trackedOf(request);
      const g = new GraphBuilder();
      await labelsGraph(g, tracked);
      return { focus: null, graph: await decorate(g, tracked) };
    });

    priv.put("/labels/:wallet", { config: { rateLimit: WRITE_LIMIT } }, async (request, reply) => {
      const p = walletParams.safeParse(request.params);
      const b = labelBody.safeParse(request.body);
      if (!p.success) return bad(reply, p.error);
      if (!b.success) return bad(reply, b.error);
      const name = cleanTrackedName(b.data.name);
      if (!name) return reply.code(400).send({ error: "Name the wallet" });
      if (!(await isPro(request))) return reply.code(403).send({ error: "Labeling wallets needs Pro Mode" });
      const ours = (await platformLabels([p.data.wallet])).get(p.data.wallet);
      if (ours)
        return reply.code(409).send({
          error: `TrenchScanner already labels this wallet${ours.label ? ` as ${ours.label}` : " as a bot"}.`,
        });
      const saved = await saveTracked(
        request.user!.userId,
        p.data.wallet,
        name,
        b.data.kol ? "kol" : "tracked",
      );
      if (!saved.ok)
        return reply
          .code(409)
          .send({ error: `You can label up to ${TRACKED_WALLET_CAP} wallets. Remove one to add another.` });
      return { wallet: saved.row };
    });

    // Removing needs no Pro Mode: a lapsed account can still clear its list.
    priv.delete("/labels/:wallet", { config: { rateLimit: WRITE_LIMIT } }, async (request, reply) => {
      const p = walletParams.safeParse(request.params);
      if (!p.success) return bad(reply, p.error);
      return { removed: await removeTracked(request.user!.userId, p.data.wallet) };
    });

    // ---------- chain reads (Pro Mode, metered) ----------

    const chainGate = async (request: FastifyRequest, reply: FastifyReply): Promise<boolean> => {
      if (!(await isPro(request))) {
        refusal(reply, { refused: "not-pro" });
        return false;
      }
      if (!opts.helius) {
        reply.code(503).send({ error: "Chain reads aren't set up on this server.", code: "unconfigured" });
        return false;
      }
      return true;
    };

    /** A wallet's recent SOL and coin transfers and its trades, from its own transactions. */
    priv.post("/chain/flows/:wallet", { config: { rateLimit: CHAIN_LIMIT } }, async (request, reply) => {
      const p = walletParams.safeParse(request.params);
      if (!p.success) return bad(reply, p.error);
      if (!(await chainGate(request, reply))) return reply;
      const res = await readWalletFlows(env, opts.helius!, request.user!.userId, p.data.wallet);
      if ("refused" in res) return refusal(reply, res);
      const g = new GraphBuilder();
      addFlows(g, res.value);
      const graph = await decorate(g, await trackedOf(request));
      return {
        focus: p.data.wallet,
        graph,
        flows: { txs: res.value.txs, fromMs: res.value.fromMs, toMs: res.value.toMs },
        credits: res.credits,
        cached: res.cached,
        allowance: res.allowance,
      };
    });

    /** Funders the tables don't have, for wallets on the map; then their funding ties. */
    priv.post("/chain/funders", { config: { rateLimit: CHAIN_LIMIT } }, async (request, reply) => {
      const b = fundersBody.safeParse(request.body);
      if (!b.success) return bad(reply, b.error);
      if (!(await chainGate(request, reply))) return reply;
      const res = await readFunders(env, opts.helius!, request.user!.userId, b.data.wallets);
      if ("refused" in res) return refusal(reply, res);
      const g = new GraphBuilder();
      for (const w of b.data.wallets) g.node(w, "wallet");
      await Promise.all(b.data.wallets.map((w) => addFunding(g, w)));
      return {
        focus: null,
        graph: await decorate(g, await trackedOf(request)),
        found: res.value,
        credits: res.credits,
        cached: res.cached,
        allowance: res.allowance,
      };
    });

    /** Any coin's top holders from the chain, tied by funding and transfers. */
    priv.post("/chain/token/:mint", { config: { rateLimit: CHAIN_LIMIT } }, async (request, reply) => {
      const p = mintParams.safeParse(request.params);
      if (!p.success) return bad(reply, p.error);
      if (!(await chainGate(request, reply))) return reply;
      const res = await readTokenHolders(env, opts.helius!, request.user!.userId, p.data.mint);
      if ("refused" in res) return refusal(reply, res);
      const g = new GraphBuilder();
      await addHolders(g, p.data.mint, res.value, "chain");
      return {
        focus: p.data.mint,
        graph: await decorate(g, await trackedOf(request)),
        credits: res.credits,
        cached: res.cached,
        allowance: res.allowance,
      };
    });

    // ---------- saved maps ----------

    priv.get("/maps", async (request) => ({
      maps: await listMaps(request.user!.userId),
      cap: MAPS_PER_USER,
    }));

    priv.get("/maps/:id", async (request, reply) => {
      const p = idParams.safeParse(request.params);
      if (!p.success) return bad(reply, p.error);
      const map = await readMap(request.user!.userId, p.data.id);
      if (!map) return reply.code(404).send({ error: "No such map" });
      return map;
    });

    priv.post(
      "/maps",
      { bodyLimit: MAP_BODY_LIMIT, config: { rateLimit: WRITE_LIMIT } },
      async (request, reply) => {
        const b = saveSchema.safeParse(request.body);
        if (!b.success) return bad(reply, b.error);
        const res = await createMap(request.user!.userId, b.data.title, b.data.doc);
        if ("error" in res)
          return reply
            .code(409)
            .send({ error: `You can keep up to ${MAPS_PER_USER} maps. Delete one to save another.` });
        return res;
      },
    );

    priv.put(
      "/maps/:id",
      { bodyLimit: MAP_BODY_LIMIT, config: { rateLimit: WRITE_LIMIT } },
      async (request, reply) => {
        const p = idParams.safeParse(request.params);
        const b = saveSchema.safeParse(request.body);
        if (!p.success) return bad(reply, p.error);
        if (!b.success) return bad(reply, b.error);
        if (!(await updateMap(request.user!.userId, p.data.id, b.data.title, b.data.doc)))
          return reply.code(404).send({ error: "No such map" });
        return { ok: true };
      },
    );

    priv.delete("/maps/:id", { config: { rateLimit: WRITE_LIMIT } }, async (request, reply) => {
      const p = idParams.safeParse(request.params);
      if (!p.success) return bad(reply, p.error);
      return { removed: await deleteMap(request.user!.userId, p.data.id) };
    });

    /** Freezes the map behind a public link; again later, the link shows the map as it is then. */
    priv.post("/maps/:id/share", { config: { rateLimit: WRITE_LIMIT } }, async (request, reply) => {
      const p = idParams.safeParse(request.params);
      if (!p.success) return bad(reply, p.error);
      const res = await shareMap(request.user!.userId, p.data.id);
      if (!res) return reply.code(404).send({ error: "No such map" });
      return res;
    });

    priv.delete("/maps/:id/share", { config: { rateLimit: WRITE_LIMIT } }, async (request, reply) => {
      const p = idParams.safeParse(request.params);
      if (!p.success) return bad(reply, p.error);
      return { unshared: await unshareMap(request.user!.userId, p.data.id) };
    });
  });
}
