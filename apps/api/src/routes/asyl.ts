import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { prisma, withApiFeature, type Env, type HeliusClient } from "@trenchscanner/core";
import { loadWalletProfile, type WalletLiveReader } from "../walletProfile.js";
import { sharedSolPrice } from "../solPrice.js";
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
  addLinksAmong,
  addPastHolders,
  addSides,
  decorate,
  deployedEdge,
  GraphBuilder,
  LINKS_TOKENS_MAX,
  loadDeployers,
  LINKS_WALLETS_MAX,
  countCoTraders,
  COTRADERS_ALL_MAX,
  COTRADERS_MAX,
  loadStoredHolders,
  PAST_HOLDER_MIN_SOL,
  STORED_DAYS,
  type PastHoldersRead,
} from "../asyl/graph.js";
import { labelsGraph, loadSimilarCoins } from "../asyl/similar.js";
import { loadPair } from "../asyl/cotrade.js";
import { searchAsyl } from "../asyl/search.js";
import { readAllowance } from "../asyl/credits.js";
import {
  addFlows,
  readDeployer,
  readFunders,
  readTokenHolders,
  readWalletFlows,
  traceFunders,
  addTrace,
  traceNote,
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
const pairParams = z.object({ a: address, b: address });
const searchQuery = z.object({ q: z.string().trim().min(2).max(60) });
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
const linksBody = z.object({
  wallets: z.array(address).max(LINKS_WALLETS_MAX).default([]),
  tokens: z.array(address).max(LINKS_TOKENS_MAX).default([]),
  deployers: z.boolean().default(false),
});

/** Each map read is a handful of indexed queries: well above what a person clicks. */
const READ_LIMIT = { max: 60, timeWindow: "1 minute" };
/** The search box asks as the reader types, a little behind each key. */
const SEARCH_LIMIT = { max: 120, timeWindow: "1 minute" };
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

/** A holder reading's age, in words: holders move, so an old list says so and how to refresh it. */
export function holdersNote(count: number, readAt: Date | null, pro: boolean, now = Date.now()): string {
  const fresher = pro
    ? "Read live holders in the coin's panel for the current list."
    : "Pro Mode can read the current list from the chain.";
  if (count === 0) return `TrenchScanner has no holder reading of this coin. ${fresher}`;
  if (!readAt) return `Top ${count} holders as TrenchScanner last read them. ${fresher}`;
  const min = Math.max(0, Math.round((now - readAt.getTime()) / 60_000));
  const age =
    min < 1
      ? "just now"
      : min < 60
        ? `${min} min ago`
        : min < 48 * 60
          ? `${Math.round(min / 60)} h ago`
          : `${Math.round(min / 1440)} days ago`;
  const at = `${readAt.toISOString().slice(11, 16)} UTC on ${readAt.toISOString().slice(0, 10)}`;
  return `Top ${count} holders as TrenchScanner read them ${age} (${at}).${min >= 60 ? ` ${fresher}` : ""}`;
}

const dayOf = (d: Date) =>
  d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/** What a past-holders read covers: whose trades, up to when, and what it can't see. */
export function pastHoldersNote(r: PastHoldersRead): string {
  const min = `${PAST_HOLDER_MIN_SOL} SOL`;
  if (!r.tape)
    return "TrenchScanner hasn't read this coin's trades, so it has no past holders to add. It reads the trades of coins it calls, samples or sees traded.";
  const upTo = `Buyers up to ${dayOf(r.tape.windowEnd)}, from TrenchScanner's read of its trades`;
  const partial =
    r.tape.status === "partial"
      ? " The read didn't reach back to its launch, so its earliest buyers may be missing."
      : "";
  if (r.total === 0) return `No wallet put ${min} or more into it. ${upTo}.${partial}`;
  const drawn = r.shown < r.total ? `; the ${r.shown} that put in most are drawn` : "";
  return `${r.total} wallet${r.total === 1 ? "" : "s"} put ${min} or more into it, sold out or still holding${drawn}. ${upTo}.${partial}`;
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
        // For the USD slider: SOL amounts on the map shown in dollars.
        solUsd: await sharedSolPrice.get().catch(() => null),
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
      const [, , seen, { coTraders, total: coTradersTotal }] = await Promise.all([
        addFunding(g, wallet),
        addHolderTransfers(g, wallet),
        addCoins(g, wallet),
        countCoTraders(wallet),
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
            : pro
              ? `Not seen in any coin TrenchScanner tracked in the last ${STORED_DAYS} days, so Asyl reads it from the chain.`
              : `Not seen in any coin TrenchScanner tracked in the last ${STORED_DAYS} days. Pro Mode reads a wallet like this from the chain.`,
      };
      reply.header("Cache-Control", "private, no-store");
      return { focus: wallet, graph: await decorate(g, tracked), coverage, coTradersTotal };
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

    /** The search box: tracked coins, roster KOLs and the reader's labels, by name (search.ts). */
    priv.get("/search", { config: { rateLimit: SEARCH_LIMIT } }, async (request, reply) => {
      const p = searchQuery.safeParse(request.query);
      if (!p.success) return bad(reply, p.error);
      reply.header("Cache-Control", "private, no-store");
      return searchAsyl(p.data.q, await trackedOf(request));
    });

    /** The trades behind a "bought together" link: each coin both bought, side by side. */
    priv.get("/pair/:a/:b", { config: { rateLimit: READ_LIMIT } }, async (request, reply) => {
      const p = pairParams.safeParse(request.params);
      if (!p.success) return bad(reply, p.error);
      reply.header("Cache-Control", "private, no-store");
      return loadPair(p.data.a, p.data.b);
    });

    /** Its co-traders, and the coins they bought that it didn't. */
    priv.get("/wallet/:wallet/similar", { config: { rateLimit: READ_LIMIT } }, async (request, reply) => {
      const p = walletParams.safeParse(request.params);
      if (!p.success) return bad(reply, p.error);
      const wallet = p.data.wallet;
      // ?all=1: every co-trader up to COTRADERS_ALL_MAX, once the reader agreed to the count.
      const all = (request.query as { all?: string } | undefined)?.all === "1";
      const tracked = await trackedOf(request);
      const { coTraders, total } = await countCoTraders(wallet, all ? COTRADERS_ALL_MAX : COTRADERS_MAX);
      const coins = await loadSimilarCoins(wallet, coTraders);
      const g = new GraphBuilder();
      g.node(wallet, "wallet");
      addCoTraders(g, wallet, coTraders);
      for (const c of coins) g.node(c.mint, "token");
      const graph = await decorate(g, tracked);
      return { focus: wallet, coTraders, total, coins, graph };
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
      const deployer = (await loadDeployers([mint])).get(mint);
      if (deployer) {
        g.node(deployer.wallet, "wallet");
        deployedEdge(g, deployer.wallet, mint, deployer.at);
      }
      const pro = await isPro(request);
      const coverage: AsylCoverage = {
        seen: stored.holders.length,
        days: STORED_DAYS,
        chainAvailable: pro,
        note: holdersNote(stored.holders.length, stored.readAt, pro),
      };
      reply.header("Cache-Control", "private, no-store");
      return {
        focus: mint,
        graph: await decorate(g, tracked),
        coverage,
        readAt: stored.readAt?.toISOString() ?? null,
      };
    });

    /** Everyone who bought a coin with PAST_HOLDER_MIN_SOL or more, from its stored trade read. */
    priv.get("/token/:mint/past-holders", { config: { rateLimit: READ_LIMIT } }, async (request, reply) => {
      const p = mintParams.safeParse(request.params);
      if (!p.success) return bad(reply, p.error);
      const g = new GraphBuilder();
      const read = await addPastHolders(g, p.data.mint);
      reply.header("Cache-Control", "private, no-store");
      return {
        focus: p.data.mint,
        graph: await decorate(g, await trackedOf(request)),
        total: read.total,
        shown: read.shown,
        note: pastHoldersNote(read),
      };
    });

    /** Stored links among what is on the map already, and with `deployers` each coin's deployer. */
    priv.post("/links", { config: { rateLimit: READ_LIMIT } }, async (request, reply) => {
      const b = linksBody.safeParse(request.body);
      if (!b.success) return bad(reply, b.error);
      const g = new GraphBuilder();
      await addLinksAmong(g, b.data.wallets, b.data.tokens, { deployers: b.data.deployers });
      reply.header("Cache-Control", "private, no-store");
      return { focus: null, graph: await decorate(g, await trackedOf(request)) };
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

    /**
     * A coin's deployer (user ask 2026-10-24: "Show deployer"): the create transaction's signer when
     * the tables have it, free; else, for Pro Mode, read from the chain (10 credits) and kept for
     * everyone; else the creator TrenchScanner was told, marked unverified.
     */
    priv.post("/deployer/:mint", { config: { rateLimit: READ_LIMIT } }, async (request, reply) => {
      const p = mintParams.safeParse(request.params);
      if (!p.success) return bad(reply, p.error);
      const mint = p.data.mint;
      let known = (await loadDeployers([mint])).get(mint) ?? null;
      let chain: { credits: number; cached: boolean; allowance: unknown } | null = null;
      if (!known?.verified && opts.helius && (await isPro(request))) {
        const res = await readDeployer(env, opts.helius, request.user!.userId, mint);
        if ("refused" in res) {
          if (!known) return refusal(reply, res);
        } else {
          chain = { credits: res.credits, cached: res.cached, allowance: res.allowance };
          if (res.value) known = res.value;
        }
      }
      const g = new GraphBuilder();
      g.node(mint, "token");
      if (known) {
        g.node(known.wallet, "wallet");
        deployedEdge(g, known.wallet, mint, known.at);
      }
      reply.header("Cache-Control", "private, no-store");
      return {
        focus: mint,
        graph: await decorate(g, await trackedOf(request)),
        deployer: known ? { wallet: known.wallet, verified: known.verified } : null,
        ...(chain ?? {}),
      };
    });

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

    /** A wallet's funder, its funder's funder, and on, to an exchange or a wallet the chain can't name a funder for. */
    priv.post("/chain/trace/:wallet", { config: { rateLimit: CHAIN_LIMIT } }, async (request, reply) => {
      const p = walletParams.safeParse(request.params);
      if (!p.success) return bad(reply, p.error);
      if (!(await chainGate(request, reply))) return reply;
      const res = await traceFunders(env, opts.helius!, request.user!.userId, p.data.wallet);
      if ("refused" in res) return refusal(reply, res);
      const g = new GraphBuilder();
      await addTrace(g, res.value);
      const graph = await decorate(g, await trackedOf(request));
      const end = res.value.path[res.value.path.length - 1]!;
      return {
        focus: p.data.wallet,
        graph,
        trace: res.value,
        note: traceNote(res.value, graph.nodes.find((n) => n.id === end)?.name ?? null),
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
        found: Object.values(res.value).filter((v) => v === "found").length,
        /** Each wallet's answer: found, none, empty, busy or failed. */
        results: res.value,
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
