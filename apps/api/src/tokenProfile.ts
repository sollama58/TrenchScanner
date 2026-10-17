import { prisma, type TokenSageAnalysis } from "@trenchscanner/core";

/**
 * GET /tokens/:mint/profile: the token modal's Dev, Socials and Order flow cards (user ask
 * 2026-10-16).
 *
 * - Dev: the creator wallet (the coin's trade tape, else Token.creator as discovery, RugCheck or
 *   the tape named it, else TokenSage's market.creator when it names a wallet), its risk score, and the other coins the scanner read the trades of that name it the
 *   creator (TokenWalletActivity.isCreator), with how each did. Only coins whose tape was read are
 *   known, so the count is a floor, and the card says so.
 * - Socials: the launcher's X, Telegram and website links, https only (Token's stored links, else
 *   TokenSage's raw ones). Launcher-supplied: the page shows them as links, never as HTML.
 * - Flow: the newest scan's buys and sells over 5 minutes and the hour, with volume and price
 *   change, and, when the coin's tape was read, how many distinct wallets bought it.
 */

export interface DevCoin {
  mint: string;
  symbol: string | null;
  at: string;
  outcome: "win" | "stop" | "fizzle" | null;
  peakPct: number | null;
}

export interface TokenProfile {
  dev: {
    wallet: string;
    /** WalletRisk score, 0-100; null when unscored. */
    risk: number | null;
    /** Other coins the scanner read that it created, newest first. */
    coins: DevCoin[];
  } | null;
  socials: {
    x: string | null;
    telegram: string | null;
    website: string | null;
    /** No source has read the coin's socials yet. */
    unread: boolean;
  };
  flow: {
    at: string;
    buys5m: number | null;
    sells5m: number | null;
    buys1h: number | null;
    sells1h: number | null;
    volume5mUsd: number | null;
    volume1hUsd: number | null;
    priceChange5mPct: number | null;
    priceChange1hPct: number | null;
    /** Distinct wallets that bought, from the trade tape; null when its tape wasn't read. */
    buyers: { count: number; through: string } | null;
  } | null;
}

const MAX_DEV_COINS = 12;
const WALLET_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** An https link as stored, else null; a bare Telegram handle becomes its t.me link. */
export function safeLink(raw: unknown, kind: "x" | "telegram" | "website"): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  if (v.length === 0 || v.length > 300) return null;
  if (kind === "telegram" && /^@?[A-Za-z0-9_]{4,64}$/.test(v)) return `https://t.me/${v.replace(/^@/, "")}`;
  if (kind === "x" && /^@?[A-Za-z0-9_]{1,15}$/.test(v)) return `https://x.com/${v.replace(/^@/, "")}`;
  try {
    const u = new URL(v);
    return u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

export async function readTokenProfile(mintAddress: string): Promise<TokenProfile | null> {
  const token = await prisma.token.findUnique({
    where: { mintAddress },
    select: {
      id: true,
      hasTwitter: true,
      hasTelegram: true,
      hasWebsite: true,
      twitterUrl: true,
      websiteUrl: true,
      creator: true,
    },
  });
  if (!token) return null;
  const [tape, narrative, snap] = await Promise.all([
    prisma.tokenTradeTape.findUnique({
      where: { tokenId: token.id },
      select: { creator: true, status: true, windowEnd: true },
    }),
    prisma.tokenNarrative.findUnique({ where: { mintAddress }, select: { analysis: true } }),
    prisma.tokenSnapshot.findFirst({
      where: { tokenId: token.id },
      orderBy: { takenAt: "desc" },
      select: {
        takenAt: true,
        buys5m: true,
        sells5m: true,
        buys1h: true,
        sells1h: true,
        volume5mUsd: true,
        volume1hUsd: true,
        priceChange5mPct: true,
        priceChange1hPct: true,
      },
    }),
  ]);
  const doc = (narrative?.analysis ?? null) as TokenSageAnalysis | null;
  const market = doc?.market ?? null;
  const sageCreator =
    market?.creator && (market.creator_kind == null || market.creator_kind === "wallet")
      ? market.creator
      : null;
  const creator =
    [tape?.creator, token.creator, sageCreator].find((w): w is string => !!w && WALLET_RE.test(w)) ?? null;

  const [risk, launches, buyers] = await Promise.all([
    creator ? prisma.walletRisk.findUnique({ where: { wallet: creator }, select: { score: true } }) : null,
    creator
      ? prisma.tokenWalletActivity.findMany({
          where: { wallet: creator, isCreator: true, tokenId: { not: token.id } },
          orderBy: { createdAt: "desc" },
          take: MAX_DEV_COINS,
          select: {
            createdAt: true,
            token: {
              select: {
                mintAddress: true,
                symbol: true,
                tradeTape: { select: { anchorAt: true, outcomeId: true } },
              },
            },
          },
        })
      : [],
    tape && tape.status !== "failed"
      ? prisma.tokenWalletActivity.count({ where: { tokenId: token.id, buys: { gt: 0 } } })
      : null,
  ]);
  const outcomeIds = launches.map((l) => l.token.tradeTape?.outcomeId).filter((id): id is string => !!id);
  const outcomes = outcomeIds.length
    ? await prisma.candidateOutcome.findMany({
        where: { id: { in: outcomeIds } },
        select: { id: true, hit2xIn1h: true, disqualified: true, stoppedAt: true, peak1hReturnPct: true },
      })
    : [];
  const byId = new Map(outcomes.map((o) => [o.id, o]));

  const x = safeLink(token.twitterUrl, "x") ?? safeLink(doc?.raw?.twitter, "x");
  const telegram = safeLink(doc?.raw?.telegram, "telegram");
  const website = safeLink(token.websiteUrl, "website") ?? safeLink(doc?.raw?.website, "website");

  return {
    dev: creator
      ? {
          wallet: creator,
          risk: risk?.score ?? null,
          coins: launches.map((l) => {
            const id = l.token.tradeTape?.outcomeId;
            const o = id ? byId.get(id) : undefined;
            return {
              mint: l.token.mintAddress,
              symbol: l.token.symbol,
              at: (l.token.tradeTape?.anchorAt ?? l.createdAt).toISOString(),
              outcome: o ? (o.hit2xIn1h && !o.disqualified ? "win" : o.stoppedAt ? "stop" : "fizzle") : null,
              peakPct: o?.peak1hReturnPct ?? null,
            };
          }),
        }
      : null,
    socials: {
      x,
      telegram,
      website,
      unread: token.hasTwitter === null && token.hasWebsite === null && !doc?.raw,
    },
    flow: snap
      ? {
          at: snap.takenAt.toISOString(),
          buys5m: snap.buys5m,
          sells5m: snap.sells5m,
          buys1h: snap.buys1h,
          sells1h: snap.sells1h,
          volume5mUsd: snap.volume5mUsd,
          volume1hUsd: snap.volume1hUsd,
          priceChange5mPct: snap.priceChange5mPct,
          priceChange1hPct: snap.priceChange1hPct,
          buyers: buyers !== null && tape ? { count: buyers, through: tape.windowEnd.toISOString() } : null,
        }
      : null,
  };
}
