import { prisma, DEV_LAUNCH_GRADE_KINDS, type TokenSageAnalysis } from "@trenchscanner/core";

/**
 * GET /tokens/:mint/profile: the token modal's Dev, Socials and Order flow cards (user ask
 * 2026-10-16).
 *
 * - Dev: the creator wallet (the create transaction's signer, else the coin's trade tape, else Token.creator as discovery, RugCheck or
 *   the tape named it, else TokenSage's market.creator when it names a wallet), its two scores - the
 *   wallet risk score (how it trades) and the dev launch score (how its launches went, user ask
 *   2026-10-17, with its funder's family) - and its other coins, with how each did: every token
 *   whose row names it the creator, and the coins whose trade tape does (TokenWalletActivity.isCreator).
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
  /** Whether it reached the alert band; null when the scanner has no token row for it. */
  reachedBand: boolean | null;
}

/** A launch record as the hourly rebuild left it (DevLaunchRisk / DevFunderRisk). */
export interface DevLaunchRecord {
  /** Dev launch score, 0-100, higher is riskier. */
  score: number;
  launches: number;
  inBand: number;
  graded: number;
  wins: number;
  stops: number;
}

export interface TokenProfile {
  dev: {
    wallet: string;
    /** WalletRisk score, 0-100, from how the wallet trades; null when unscored. */
    risk: number | null;
    /** Its launches in the last 14 days and their score, this coin included once it is an hour old; null without a record. */
    launch: DevLaunchRecord | null;
    /** The creators its funder paid for, itself included, pooled; null without a family. */
    family: (DevLaunchRecord & { creators: number }) | null;
    /** Other coins it created that the scanner knows of, newest first. */
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

/** Hosts the X and Telegram slots may point at; anything else under that label would mislead. */
const SOCIAL_HOSTS: Record<"x" | "telegram", ReadonlySet<string>> = {
  x: new Set(["x.com", "www.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com"]),
  telegram: new Set(["t.me", "www.t.me", "telegram.me", "www.telegram.me"]),
};

/**
 * An https link as stored, else null; a bare Telegram handle becomes its t.me link. The launcher
 * writes these, so a link with userinfo (`https://x.com@evil.example/` shows x.com, opens
 * evil.example) is dropped, and the X and Telegram slots only keep their own hosts.
 */
export function safeLink(raw: unknown, kind: "x" | "telegram" | "website"): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  if (v.length === 0 || v.length > 300) return null;
  if (kind === "telegram" && /^@?[A-Za-z0-9_]{4,64}$/.test(v)) return `https://t.me/${v.replace(/^@/, "")}`;
  if (kind === "x" && /^@?[A-Za-z0-9_]{1,15}$/.test(v)) return `https://x.com/${v.replace(/^@/, "")}`;
  try {
    const u = new URL(v);
    if (u.protocol !== "https:" || u.username || u.password) return null;
    if (kind !== "website" && !SOCIAL_HOSTS[kind].has(u.hostname.toLowerCase())) return null;
    return u.toString();
  } catch {
    return null;
  }
}

function launchRecord(r: DevLaunchRecord): DevLaunchRecord {
  return {
    score: r.score,
    launches: r.launches,
    inBand: r.inBand,
    graded: r.graded,
    wins: r.wins,
    stops: r.stops,
  };
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
      telegramUrl: true,
      websiteUrl: true,
      creator: true,
      deployer: true,
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
  // The create transaction's signer first (Asyl's deployer read): Pump.fun's `creator` follows a
  // community takeover's fee wallet, which launched nothing.
  const creator =
    [token.deployer, tape?.creator, token.creator, sageCreator].find(
      (w): w is string => !!w && WALLET_RE.test(w),
    ) ?? null;

  const coinSelect = {
    mintAddress: true,
    symbol: true,
    firstSeenAt: true,
    firstInBandAt: true,
    tradeTape: { select: { anchorAt: true, outcomeId: true } },
  } as const;
  const [risk, launchRow, created, taped, buyers] = await Promise.all([
    creator ? prisma.walletRisk.findUnique({ where: { wallet: creator }, select: { score: true } }) : null,
    creator
      ? prisma.devLaunchRisk.findUnique({
          where: { wallet: creator },
          select: {
            score: true,
            launches: true,
            inBand: true,
            graded: true,
            wins: true,
            stops: true,
            funder: true,
          },
        })
      : null,
    creator
      ? prisma.token.findMany({
          where: { OR: [{ creator }, { deployer: creator }], id: { not: token.id } },
          orderBy: { firstSeenAt: "desc" },
          take: MAX_DEV_COINS,
          select: { id: true, ...coinSelect },
        })
      : [],
    creator
      ? prisma.tokenWalletActivity.findMany({
          where: { wallet: creator, isCreator: true, tokenId: { not: token.id } },
          orderBy: { createdAt: "desc" },
          take: MAX_DEV_COINS,
          select: { createdAt: true, token: { select: { id: true, ...coinSelect } } },
        })
      : [],
    tape && tape.status !== "failed"
      ? prisma.tokenWalletActivity.count({ where: { tokenId: token.id, buys: { gt: 0 } } })
      : null,
  ]);
  const family = launchRow?.funder
    ? await prisma.devFunderRisk.findUnique({
        where: { funder: launchRow.funder },
        select: {
          creators: true,
          score: true,
          launches: true,
          inBand: true,
          graded: true,
          wins: true,
          stops: true,
        },
      })
    : null;

  // Every coin it created that the scanner knows of, once each, newest first.
  const coinsById = new Map<string, { at: Date; t: (typeof created)[number] }>();
  for (const t of created) coinsById.set(t.id, { at: t.tradeTape?.anchorAt ?? t.firstSeenAt, t });
  for (const l of taped) {
    if (!coinsById.has(l.token.id))
      coinsById.set(l.token.id, { at: l.token.tradeTape?.anchorAt ?? l.createdAt, t: l.token });
  }
  const coins = [...coinsById.values()]
    .sort((a, b) => b.at.getTime() - a.at.getTime())
    .slice(0, MAX_DEV_COINS);
  // A coin's grade: its call's when its tape was read (as before), else its first finalized
  // sample's - the grade the dev launch score counts.
  const outcomeIds = coins.map((c) => c.t.tradeTape?.outcomeId).filter((id): id is string => !!id);
  const firstGradeOf = coins.filter((c) => !c.t.tradeTape?.outcomeId && c.t.firstInBandAt).map((c) => c.t.id);
  const [byOutcomeId, firstGrades] = await Promise.all([
    outcomeIds.length
      ? prisma.candidateOutcome.findMany({
          where: { id: { in: outcomeIds } },
          select: { id: true, hit2xIn1h: true, disqualified: true, stoppedAt: true, peak1hReturnPct: true },
        })
      : [],
    firstGradeOf.length
      ? prisma.$queryRaw<
          {
            tokenId: string;
            hit2xIn1h: boolean | null;
            disqualified: boolean | null;
            stoppedAt: Date | null;
            peak1hReturnPct: number | null;
          }[]
        >`
          SELECT DISTINCT ON (c."tokenId") c."tokenId", c."hit2xIn1h", c."disqualified", c."stoppedAt", c."peak1hReturnPct"
          FROM "CandidateOutcome" c
          WHERE c."tokenId" = ANY(${firstGradeOf}::text[])
            AND c."sampleKind" = ANY(${[...DEV_LAUNCH_GRADE_KINDS]})
            AND c."finalizedAt" IS NOT NULL
          ORDER BY c."tokenId", c."anchorAt" ASC`
      : [],
  ]);
  const byId = new Map(byOutcomeId.map((o) => [o.id, o]));
  const byToken = new Map(firstGrades.map((o) => [o.tokenId, o]));

  const x = safeLink(token.twitterUrl, "x") ?? safeLink(doc?.raw?.twitter, "x");
  const telegram = safeLink(token.telegramUrl, "telegram") ?? safeLink(doc?.raw?.telegram, "telegram");
  const website = safeLink(token.websiteUrl, "website") ?? safeLink(doc?.raw?.website, "website");

  return {
    dev: creator
      ? {
          wallet: creator,
          risk: risk?.score ?? null,
          launch: launchRow ? launchRecord(launchRow) : null,
          family: family ? { ...launchRecord(family), creators: family.creators } : null,
          coins: coins.map(({ at, t }) => {
            const id = t.tradeTape?.outcomeId;
            const o = id ? byId.get(id) : byToken.get(t.id);
            return {
              mint: t.mintAddress,
              symbol: t.symbol,
              at: at.toISOString(),
              outcome: o ? (o.hit2xIn1h && !o.disqualified ? "win" : o.stoppedAt ? "stop" : "fizzle") : null,
              peakPct: o?.peak1hReturnPct ?? null,
              reachedBand: t.firstInBandAt !== null,
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
