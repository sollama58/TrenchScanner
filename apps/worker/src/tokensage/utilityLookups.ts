import { createLogger, prisma, tokenSageEnabled, tokenSageHints, type Env } from "@trenchscanner/core";
import { noteNarrativeWanted } from "./prefetch.js";

const logger = createLogger("utility-lookups");

/** A token lookup this recent still wants its TokenSage read (the read lands within minutes). */
const UTILITY_READ_WINDOW_MS = 15 * 60_000;
/** Lookups read per cycle at most: each is a paid credit, so this is far above real use. */
const MAX_PER_CYCLE = 50;

/**
 * Asks TokenSage for a full read of every mint the Utilities tab looked up recently (a "spend"
 * row on the Burn Credit ledger, apps/api routes/utilities.ts). The scan itself only asks for a
 * read when a coin passes the rug screen on the watchlist; a looked-up coin was paid for and its
 * view shows TokenSage's read, so it is asked for at full depth whatever the screen says. A mint
 * already read at full depth is skipped by noteNarrativeWanted, so calling this every cycle is free.
 */
export async function noteUtilityLookups(env: Env, now = Date.now()): Promise<number> {
  if (!tokenSageEnabled(env)) return 0;
  const lookups = await prisma.burnCreditEntry.findMany({
    where: { kind: "spend", utility: "token", createdAt: { gt: new Date(now - UTILITY_READ_WINDOW_MS) } },
    orderBy: { createdAt: "desc" },
    distinct: ["subject"],
    take: MAX_PER_CYCLE,
    select: { subject: true },
  });
  // Coins a Pro Mode wallet just bought into: the TRADES panel scans them like a lookup
  // (apps/api routes/proTrades.ts), so they want the same read.
  const entries = await prisma.proTrade.findMany({
    where: { entry: true, at: { gt: new Date(now - UTILITY_READ_WINDOW_MS) } },
    orderBy: { at: "desc" },
    distinct: ["mint"],
    take: MAX_PER_CYCLE,
    select: { mint: true },
  });
  const mints = [
    ...new Set([...lookups.flatMap((l) => (l.subject ? [l.subject] : [])), ...entries.map((e) => e.mint)]),
  ];
  if (mints.length === 0) return 0;
  const tokens = await prisma.token.findMany({
    where: { mintAddress: { in: mints } },
    select: {
      mintAddress: true,
      name: true,
      symbol: true,
      description: true,
      imageUrl: true,
      twitterUrl: true,
      websiteUrl: true,
      launchedAt: true,
    },
  });
  for (const token of tokens) noteNarrativeWanted(token.mintAddress, "full", env, tokenSageHints(token));
  logger.debug("asked for full reads of looked-up tokens", { count: tokens.length });
  return tokens.length;
}
