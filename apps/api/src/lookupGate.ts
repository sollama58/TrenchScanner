import type { FastifyReply, FastifyRequest } from "fastify";
import { burnCreditPrices, createLogger, openLookup, prisma, type UtilityKind } from "@trenchscanner/core";
import { seenWallets } from "./walletNames.js";

const logger = createLogger("lookup-gate");

/**
 * Keys (a reader and a coin, or a coin) that passed a database-backed gate lately. When the
 * database errors, a key in here is let through instead of the request failing, so the live tail
 * and Live trades, which answer from memory, keep going through a database outage (charts audit
 * item 6, user ask 2026-10-19 "fix all"). A key never seen still needs the database.
 */
export class RecentlyAllowed {
  private readonly at = new Map<string, number>();

  constructor(
    private readonly ttlMs = 15 * 60_000,
    private readonly maxKeys = 20_000,
    private readonly now: () => number = Date.now,
  ) {}

  remember(key: string): void {
    this.at.delete(key);
    this.at.set(key, this.now());
    while (this.at.size > this.maxKeys) {
      const oldest = this.at.keys().next().value;
      if (oldest === undefined) break;
      this.at.delete(oldest);
    }
  }

  has(key: string, withinMs = this.ttlMs): boolean {
    const at = this.at.get(key);
    return at !== undefined && this.now() - at < Math.min(withinMs, this.ttlMs);
  }

  /**
   * `check`'s answer, remembering a yes. When it throws (the database), a key let through within
   * the TTL is let through again and the error is logged; otherwise the error stands. With
   * `reuseMs`, a yes that recent is answered again without running `check` at all.
   */
  async pass(key: string, check: () => Promise<boolean>, what: string, reuseMs = 0): Promise<boolean> {
    if (reuseMs > 0 && this.has(key, reuseMs)) return true;
    try {
      const yes = await check();
      if (yes) this.remember(key);
      return yes;
    } catch (err) {
      if (!this.has(key)) throw err;
      logger.warn("gate read failed; letting a recent pass through", { gate: what, error: String(err) });
      return true;
    }
  }
}

/** allowLookupRead's recent passes, by reader, utility and subject. */
const recentReads = new RecentlyAllowed();

/**
 * How long allowLookupRead reuses a yes without asking the database again. The token view's live
 * tail and Live trades long-poll about once a second each, and every ask ran the whole gate: for a
 * coin opened as a Pro trade or a paid lookup (not on the feed, so mintOnFeed's cache never holds
 * it) that was four or five queries per ask (API audit 2026-10-19). A minute is mintOnFeed's own
 * reuse; a lookup's re-open window or a trade's listing ends at most that much late.
 */
const LOOKUP_PASS_REUSE_MS = 60_000;

/**
 * The paid lookups' free twins (P17, 2026-10-14): the wallet modal's read (GET /wallets/:wallet)
 * and the token modal's reads (GET /tokens/:mint, /chart, /sage) serve any address, so without a
 * gate they gave away what the Utilities tab sells for Burn Credits. They stay free for what the
 * product itself shows - a coin the scanner tracks, a wallet TrenchScanner has come across - and
 * need the reader's own open lookup (POST /utilities/token or /wallet, inside its re-open window)
 * for anything else. Admins are never asked.
 */

/**
 * Mints found on the feed lately: a coin on it stays on it, and the live chart's long-poll asks
 * about once a second per viewer (#719), so a yes is kept a minute rather than read every time.
 */
const ON_FEED_MS = 60_000;
const ON_FEED_MAX = 5_000;
const onFeedAt = new Map<string, number>();

/** Whether the scanner tracks the mint on its own: on Token, and not only because someone looked it up. */
export async function mintOnFeed(mint: string, now = Date.now()): Promise<boolean> {
  const seen = onFeedAt.get(mint);
  if (seen !== undefined && now - seen < ON_FEED_MS) return true;
  const yes = await readMintOnFeed(mint);
  if (yes) {
    if (onFeedAt.size >= ON_FEED_MAX) onFeedAt.clear();
    onFeedAt.set(mint, now);
  }
  return yes;
}

async function readMintOnFeed(mint: string): Promise<boolean> {
  const token = await prisma.token.findUnique({
    where: { mintAddress: mint },
    select: { id: true, discoverySource: true },
  });
  if (!token) return false;
  if (token.discoverySource !== "utility") return true;
  // A looked-up coin a model or a filter alerted on since is on the feed like any other.
  const [call, match] = await Promise.all([
    prisma.curatedAlert.findFirst({ where: { tokenId: token.id }, select: { id: true } }),
    prisma.match.findFirst({ where: { tokenId: token.id }, select: { id: true } }),
  ]);
  return call !== null || match !== null;
}

/** Which of `mints` the scanner tracks on its own (mintOnFeed's rule), in a few queries for all of them. */
export async function mintsOnFeed(mints: readonly string[], now = Date.now()): Promise<Set<string>> {
  const out = new Set<string>();
  const unknown: string[] = [];
  for (const mint of new Set(mints)) {
    const seen = onFeedAt.get(mint);
    if (seen !== undefined && now - seen < ON_FEED_MS) out.add(mint);
    else unknown.push(mint);
  }
  if (unknown.length === 0) return out;
  const tokens = await prisma.token.findMany({
    where: { mintAddress: { in: unknown } },
    select: { id: true, mintAddress: true, discoverySource: true },
  });
  const lookedUp = tokens.filter((t) => t.discoverySource === "utility").map((t) => t.id);
  const [calls, matches] = lookedUp.length
    ? await Promise.all([
        prisma.curatedAlert.findMany({
          where: { tokenId: { in: lookedUp } },
          distinct: ["tokenId"],
          select: { tokenId: true },
        }),
        prisma.match.findMany({
          where: { tokenId: { in: lookedUp } },
          distinct: ["tokenId"],
          select: { tokenId: true },
        }),
      ])
    : [[], []];
  const alerted = new Set([...calls, ...matches].map((r) => r.tokenId));
  for (const t of tokens) {
    if (t.discoverySource === "utility" && !alerted.has(t.id)) continue;
    out.add(t.mintAddress);
    if (onFeedAt.size >= ON_FEED_MAX) onFeedAt.clear();
    onFeedAt.set(t.mintAddress, now);
  }
  return out;
}

/** Whether TrenchScanner knows the wallet: a KOL on the roster, or one a scan or tape has seen. */
export async function walletOnFeed(wallet: string): Promise<boolean> {
  const kol = await prisma.kolWallet.findUnique({ where: { wallet }, select: { wallet: true } });
  if (kol) return true;
  return (await seenWallets([wallet])).has(wallet);
}

/** How long the TRADES panel lists a trade (routes/proTrades.ts), and so how long it opens the coin. */
const TRADED_MINT_MS = 30 * 86_400_000;

/** Whether the wallet's own trades (ProTrade, the TRADES panel) include the mint lately. */
export async function tradedMint(wallet: string, mint: string, now = Date.now()): Promise<boolean> {
  const row = await prisma.proTrade.findFirst({
    where: { wallet, mint, at: { gt: new Date(now - TRADED_MINT_MS) } },
    select: { at: true },
  });
  return row !== null;
}

/** Why a lookup costs nothing: the subject is one the dashboard already opens free for this reader. */
export type FreeLookupReason = "tracked" | "traded" | "own";

/**
 * Whether looking `subject` up would cost TrenchScanner nothing it doesn't already spend: a coin
 * the scanner tracks (or the reader traded with Pro Mode), a wallet it already knows, the reader's
 * own wallet. The token and wallet modals open these free (allowLookupRead), so the Utilities tab
 * doesn't charge for them either (user ask 2026-10-18). Null when the lookup is paid.
 */
export async function freeLookupReason(
  reader: string,
  utility: UtilityKind,
  subject: string,
): Promise<FreeLookupReason | null> {
  if (utility === "wallet") {
    if (subject === reader) return "own";
    return (await walletOnFeed(subject)) ? "tracked" : null;
  }
  if (await mintOnFeed(subject)) return "tracked";
  // A coin the reader traded with Pro Mode: the TRADES panel scanned it on the entry, and its
  // card opens the token modal for as long as the trade is listed there (routes/proTrades.ts).
  if (await tradedMint(reader, subject)) return "traded";
  return null;
}

/**
 * Lets the request through (returns true), or answers 402 with code "lookup_required" and the
 * lookup's price, so the dashboard can point at the Utilities tab.
 */
export async function allowLookupRead(
  request: FastifyRequest,
  reply: FastifyReply,
  utility: UtilityKind,
  subject: string,
): Promise<boolean> {
  if (request.access?.reason === "admin") return true;
  const reader = request.user!.walletAddress;
  const allowed = await recentReads.pass(
    `${reader}:${utility}:${subject}`,
    async () =>
      !!(await freeLookupReason(reader, utility, subject)) || !!(await openLookup(reader, utility, subject)),
    "lookup read",
    LOOKUP_PASS_REUSE_MS,
  );
  if (allowed) return true;
  const cost = (await burnCreditPrices()).cost[utility];
  const what = utility === "token" ? "coin" : "wallet";
  await reply.code(402).send({
    error: `TrenchScanner doesn't track this ${what}. Look it up in the Utilities tab to open it (${cost} Burn Credit${cost === 1 ? "" : "s"}).`,
    code: "lookup_required",
    utility,
    cost,
  });
  return false;
}
