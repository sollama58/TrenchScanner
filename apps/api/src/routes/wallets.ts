import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { withApiFeature, type Env } from "@trenchscanner/core";
import { loadWalletProfile, type WalletLiveReader } from "../walletProfile.js";
import type { WalletIdentityReader } from "../walletIdentity.js";
import { loadWalletNames } from "../walletNames.js";
import { loadPossibleSides } from "../possibleSides.js";
import { allowLookupRead } from "../lookupGate.js";
import { proStatus } from "../proMode.js";
import {
  activeTracked,
  cleanTrackedName,
  importTracked,
  listTracked,
  loadTrackedSides,
  mergeSides,
  removeTracked,
  saveTracked,
  TRACKED_NAME_MAX,
  TRACKED_WALLET_CAP,
  withTrackedNames,
} from "../trackedWallets.js";

/**
 * The wallet modal's read (GET /wallets/:wallet): one wallet in full, for anyone with access
 * (authenticateSubscriber, like the token modal it opens from). See walletProfile.ts. A wallet
 * TrenchScanner has never come across needs the reader's own paid lookup first (lookupGate.ts).
 * The holder lists' names (POST /wallets/names): the KOL, identity or exchange name of each wallet
 * on one list, in one read. Helius is asked only about wallets the database has seen, within each
 * account's own share of the budget. See walletNames.ts.
 * The bubble map's possible KOL side wallets (POST /wallets/possible-sides): which of a list's
 * wallets the Side Wallet Checker marks as a KOL's possible side wallet. See possibleSides.ts.
 * The reader's own labels (GET /wallets/tracked, PUT and DELETE /wallets/tracked/:wallet, and
 * POST /wallets/tracked/import for a JSON list): Pro Mode only, at most TRACKED_WALLET_CAP. The names, possible sides and wallet reads lay them over
 * their answers for that reader alone. See trackedWallets.ts.
 */

const address = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "not a Solana address");
const walletSchema = z.object({ wallet: address });
/** Each open reads the chain once (two 1-credit calls, cached): well above what a person clicks. */
const WALLET_ROUTE_RATE_LIMIT = { max: 30, timeWindow: "1 minute" };
/** One read per list a modal shows (holders, flagged wallets, linked wallets). */
const NAMES_ROUTE_RATE_LIMIT = { max: 60, timeWindow: "1 minute" };
/** The longest list read at once: two Helius batches. */
const MAX_NAMES = 200;
const namesSchema = z.object({ wallets: z.array(address).min(1).max(MAX_NAMES) });
const trackedSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(TRACKED_NAME_MAX * 4),
  /** Shown with the KOLs; otherwise the User Tracked kind. */
  kol: z.boolean().default(false),
});
/** Label edits: a person adds or renames a handful at a time. */
const TRACKED_ROUTE_RATE_LIMIT = { max: 30, timeWindow: "1 minute" };
/** A whole list at once (the web app reads the JSON file and sends its entries). */
const importSchema = z.object({
  wallets: z
    .array(trackedSchema.extend({ wallet: address }))
    .min(1)
    .max(TRACKED_WALLET_CAP),
});
const IMPORT_ROUTE_RATE_LIMIT = { max: 6, timeWindow: "1 minute" };

export async function registerWalletRoutes(
  app: FastifyInstance,
  opts: { env?: Env; live: WalletLiveReader | null; identity?: WalletIdentityReader | null },
) {
  app.addHook("preHandler", app.authenticateSubscriber);

  /** The reader's labels that apply now (none without Pro Mode). */
  const trackedOf = (request: FastifyRequest) => activeTracked(opts.env, request.user);

  /** Whether the reader has Pro Mode now: labels can be listed by anyone, changed only with it. */
  const isPro = async (request: FastifyRequest) =>
    !!opts.env && !!request.user && (await proStatus(opts.env, request.user.walletAddress)).pro;

  // Before "/:wallet", so "tracked" is never read as an address (it isn't one either way).
  app.get("/tracked", async (request) => {
    const pro = await isPro(request).catch(() => false);
    return {
      pro,
      cap: TRACKED_WALLET_CAP,
      nameMax: TRACKED_NAME_MAX,
      wallets: await listTracked(request.user!.userId),
    };
  });

  app.put("/tracked/:wallet", { config: { rateLimit: TRACKED_ROUTE_RATE_LIMIT } }, async (request, reply) => {
    const params = walletSchema.safeParse(request.params);
    const body = trackedSchema.safeParse(request.body);
    if (!params.success || !body.success)
      return reply.code(400).send({
        error: (!params.success ? params.error : body.error!).issues[0]?.message ?? "invalid request",
      });
    const name = cleanTrackedName(body.data.name);
    if (!name) return reply.code(400).send({ error: "name the wallet" });
    if (!(await isPro(request))) return reply.code(403).send({ error: "Labeling wallets needs Pro Mode" });
    const saved = await saveTracked(
      request.user!.userId,
      params.data.wallet,
      name,
      body.data.kol ? "kol" : "tracked",
    );
    if (!saved.ok)
      return reply
        .code(409)
        .send({ error: `You can label up to ${TRACKED_WALLET_CAP} wallets. Remove one to add another.` });
    return { wallet: saved.row };
  });

  app.post("/tracked/import", { config: { rateLimit: IMPORT_ROUTE_RATE_LIMIT } }, async (request, reply) => {
    const body = importSchema.safeParse(request.body);
    if (!body.success)
      return reply.code(400).send({ error: body.error.issues[0]?.message ?? "invalid request" });
    if (!(await isPro(request))) return reply.code(403).send({ error: "Labeling wallets needs Pro Mode" });
    // A wallet listed twice takes its last entry; one whose name cleans to nothing is skipped.
    const byWallet = new Map<string, { wallet: string; name: string; category: "kol" | "tracked" }>();
    let unnamed = 0;
    for (const e of body.data.wallets) {
      const name = cleanTrackedName(e.name);
      if (!name) {
        unnamed += 1;
        continue;
      }
      byWallet.delete(e.wallet);
      byWallet.set(e.wallet, { wallet: e.wallet, name, category: e.kol ? "kol" : "tracked" });
    }
    const result = byWallet.size
      ? await importTracked(request.user!.userId, [...byWallet.values()])
      : { added: 0, updated: 0, overCap: 0 };
    return { ...result, unnamed, cap: TRACKED_WALLET_CAP };
  });

  // Removing is allowed without Pro Mode: a lapsed account can still clear its own list.
  app.delete(
    "/tracked/:wallet",
    { config: { rateLimit: TRACKED_ROUTE_RATE_LIMIT } },
    async (request, reply) => {
      const params = walletSchema.safeParse(request.params);
      if (!params.success)
        return reply.code(400).send({ error: params.error.issues[0]?.message ?? "invalid request" });
      return { removed: await removeTracked(request.user!.userId, params.data.wallet) };
    },
  );

  app.get("/:wallet", { config: { rateLimit: WALLET_ROUTE_RATE_LIMIT } }, async (request, reply) => {
    const parsed = walletSchema.safeParse(request.params);
    if (!parsed.success)
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    if (!(await allowLookupRead(request, reply, "wallet", parsed.data.wallet))) return reply;
    reply.header("Cache-Control", "private, max-age=30");
    // Its chain reads count as "wallet-modal" in Admin > API usage.
    const tracked = await trackedOf(request);
    return withApiFeature("wallet-modal", () =>
      loadWalletProfile(parsed.data.wallet, opts.live, opts.identity ?? null, tracked),
    );
  });

  app.post("/names", { config: { rateLimit: NAMES_ROUTE_RATE_LIMIT } }, async (request, reply) => {
    const parsed = namesSchema.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    // Its Helius reads count as "wallet-names" in Admin > API usage.
    const [read, tracked] = await Promise.all([
      withApiFeature("wallet-names", () =>
        loadWalletNames(parsed.data.wallets, opts.identity ?? null, request.user!.userId),
      ),
      trackedOf(request),
    ]);
    return { ...read, names: withTrackedNames(read.names, tracked, parsed.data.wallets) };
  });

  // A read of the hourly table only: no outside calls.
  app.post("/possible-sides", { config: { rateLimit: NAMES_ROUTE_RATE_LIMIT } }, async (request, reply) => {
    const parsed = namesSchema.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    const tracked = await trackedOf(request);
    const [base, own] = await Promise.all([
      loadPossibleSides(parsed.data.wallets),
      loadTrackedSides(tracked, parsed.data.wallets).catch(() => ({})),
    ]);
    return { sides: mergeSides(base, own, tracked) };
  });
}
