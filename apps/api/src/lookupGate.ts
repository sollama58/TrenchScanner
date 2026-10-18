import type { FastifyReply, FastifyRequest } from "fastify";
import { burnCreditPrices, openLookup, prisma, type UtilityKind } from "@trenchscanner/core";
import { seenWallets } from "./walletNames.js";

/**
 * The paid lookups' free twins (P17, 2026-10-14): the wallet modal's read (GET /wallets/:wallet)
 * and the token modal's reads (GET /tokens/:mint, /chart, /sage) serve any address, so without a
 * gate they gave away what the Utilities tab sells for Burn Credits. They stay free for what the
 * product itself shows - a coin the scanner tracks, a wallet TrenchScanner has come across - and
 * need the reader's own open lookup (POST /utilities/token or /wallet, inside its re-open window)
 * for anything else. Admins are never asked.
 */

/** Whether the scanner tracks the mint on its own: on Token, and not only because someone looked it up. */
export async function mintOnFeed(mint: string): Promise<boolean> {
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
  if (utility === "wallet" && subject === reader) return true;
  const onFeed = utility === "token" ? await mintOnFeed(subject) : await walletOnFeed(subject);
  if (onFeed) return true;
  if (await openLookup(reader, utility, subject)) return true;
  // A coin the reader traded with Pro Mode: the TRADES panel scanned it on the entry, and its
  // card opens the token modal for as long as the trade is listed there (routes/proTrades.ts).
  if (utility === "token" && (await tradedMint(reader, subject))) return true;
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
