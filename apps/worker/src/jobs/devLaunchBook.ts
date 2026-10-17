import {
  prisma,
  createLogger,
  coinDevLaunch,
  DEV_LAUNCH_GRADE_KINDS,
  DEV_LAUNCH_SETTLE_MS,
  DEV_LAUNCH_WINDOW_DAYS,
  EMPTY_DEV_LAUNCH_STATS,
  type DevFamilyEntry,
  type DevLaunchEntry,
  type DevLaunchFeatures,
  type DevLaunchMarket,
  type DevLaunchStats,
} from "@trenchscanner/core";

const logger = createLogger("dev-launch-book");

/**
 * The scanner's copy of the dev launch scores (DevLaunchRisk, DevFunderRisk), for the reading
 * recorded at each decision (core's coinDevLaunch). Rebuilt hourly by the trainer
 * (devLaunchRiskJob.ts); re-read here every RELOAD_MS in the background, like walletRiskBook.ts: a
 * cycle never waits on it, and reads nothing until the first load lands.
 */
const RELOAD_MS = 10 * 60_000;

interface Book {
  devs: Map<string, DevLaunchEntry>;
  families: Map<string, DevFamilyEntry>;
  market: DevLaunchMarket;
  /** The rebuild's own cut (its heartbeat's builtAt): the own-launch read must use the same one. */
  builtAt: Date;
}

let book: Book | null = null;
let loadedAt = 0;
let loading: Promise<void> | null = null;

const counts = {
  launches: true,
  inBand: true,
  graded: true,
  wins: true,
  stops: true,
} as const;

/** Starts a reload when the copy is due; never throws, never waits. */
export function refreshDevLaunchBook(now = Date.now()): void {
  if (loading || now - loadedAt < RELOAD_MS) return;
  loading = Promise.all([
    prisma.devLaunchRisk.findMany({ select: { wallet: true, funder: true, ...counts } }),
    prisma.devFunderRisk.findMany({ select: { funder: true, creators: true, ...counts } }),
    prisma.systemHeartbeat.findUnique({ where: { job: "dev-launch-risk" }, select: { meta: true } }),
  ])
    .then(([devs, families, heartbeat]) => {
      const meta = (heartbeat?.meta ?? null) as Record<string, unknown> | null;
      const builtAt = typeof meta?.builtAt === "string" ? new Date(meta.builtAt) : null;
      const rate = (k: string) => (typeof meta?.[k] === "number" ? (meta[k] as number) : null);
      const bandRate = rate("bandRate");
      const winRate = rate("winRate");
      const stopRate = rate("stopRate");
      // No rebuild yet, or one from before the cut was recorded: nothing to read a coin against.
      if (
        !builtAt ||
        Number.isNaN(builtAt.getTime()) ||
        bandRate === null ||
        winRate === null ||
        stopRate === null
      ) {
        book = null;
      } else {
        book = {
          devs: new Map(devs.map(({ wallet, ...r }) => [wallet, r])),
          families: new Map(families.map(({ funder, ...r }) => [funder, r])),
          market: { bandRate, winRate, stopRate },
          builtAt,
        };
      }
      loadedAt = Date.now();
    })
    .catch((err: unknown) => {
      // Tried again after the interval, not every cycle.
      loadedAt = Date.now();
      logger.warn("dev launch risk load failed", { error: String(err) });
    })
    .finally(() => (loading = null));
}

export interface DevLaunchCoin {
  mintAddress: string;
  /** The coin's own token row, when it has one. */
  token: {
    id: string;
    creator: string | null;
    firstSeenAt: Date;
    firstInBandAt: Date | null;
  } | null;
  /** The creator another source named this cycle (RugCheck, the discovery source). */
  creator?: string | null;
}

const WALLET_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** The creator the reading is for: the token row's (what the rebuild counted it under) first. */
function creatorOf(c: DevLaunchCoin): string | null {
  return [c.token?.creator, c.creator].find((w): w is string => !!w && WALLET_RE.test(w)) ?? null;
}

/**
 * Each coin's dev launch reading, keyed by mint, for the coins whose creator is known. Two
 * queries for the cycle: the coins' own grades as the rebuild read them (to take their own launch
 * back out), and the funders of creators the rebuild had no family for (a new creator from a known
 * farm). Empty while no rebuild is loaded or when a read fails: an unknown is left unknown, never
 * read with the coin's own result in it.
 */
export async function devLaunchReadings(
  coins: readonly DevLaunchCoin[],
): Promise<Map<string, DevLaunchFeatures>> {
  const out = new Map<string, DevLaunchFeatures>();
  const b = book;
  if (!b) return out;
  const withCreator = coins.flatMap((c) => {
    const creator = creatorOf(c);
    return creator ? [{ coin: c, creator }] : [];
  });
  if (withCreator.length === 0) return out;
  try {
    const own = await ownLaunchesOf(
      withCreator.map(({ coin, creator }) => ({ token: coin.token, creator })),
      b.builtAt,
    );
    const unfunded = [
      ...new Set(
        withCreator.filter(({ creator }) => !b.devs.get(creator)?.funder).map(({ creator }) => creator),
      ),
    ];
    const funders = unfunded.length
      ? await prisma.walletFunder.findMany({
          where: { wallet: { in: unfunded }, status: "found", funder: { not: null } },
          select: { wallet: true, funder: true },
        })
      : [];
    const funderOf = new Map(funders.map((f) => [f.wallet, f.funder!]));
    for (const { coin, creator } of withCreator) {
      const entry = b.devs.get(creator);
      const funder = entry?.funder ?? funderOf.get(creator) ?? null;
      const family = funder && funder !== creator ? b.families.get(funder) : undefined;
      out.set(
        coin.mintAddress,
        coinDevLaunch(
          entry,
          family,
          (coin.token && own.get(coin.token.id)) || EMPTY_DEV_LAUNCH_STATS,
          b.market,
        ),
      );
    }
    return out;
  } catch (err) {
    logger.warn("dev launch reading failed - left off this cycle", { error: String(err) });
    return new Map();
  }
}

/**
 * What the rebuild at `builtAt` counted for each coin itself, by token id: the same rule as
 * devLaunchRiskJob.ts (counted when first seen in the window and settled by then, under the creator
 * its row names; in the band when firstInBandAt is before the cut; graded from its earliest outcome
 * row of DEV_LAUNCH_GRADE_KINDS finalized before the cut). A coin the rebuild didn't count is absent.
 */
export async function ownLaunchesOf(
  coins: readonly { token: DevLaunchCoin["token"]; creator: string }[],
  builtAt: Date,
): Promise<Map<string, DevLaunchStats>> {
  const since = builtAt.getTime() - DEV_LAUNCH_WINDOW_DAYS * 86_400_000;
  const settled = builtAt.getTime() - DEV_LAUNCH_SETTLE_MS;
  const counted = coins.flatMap(({ token, creator }) =>
    token &&
    token.creator === creator &&
    token.firstSeenAt.getTime() >= since &&
    token.firstSeenAt.getTime() < settled
      ? [token]
      : [],
  );
  const out = new Map<string, DevLaunchStats>();
  if (counted.length === 0) return out;
  const banded = counted.filter((t) => t.firstInBandAt !== null).map((t) => t.id);
  const grades = banded.length
    ? await prisma.$queryRaw<{ tokenId: string; win: boolean; stop: boolean }[]>`
        SELECT DISTINCT ON (c."tokenId") c."tokenId",
               (c."hit2xIn1h" IS TRUE AND c."disqualified" IS NOT TRUE) AS "win",
               (c."stoppedAt" IS NOT NULL) AS "stop"
        FROM "CandidateOutcome" c
        WHERE c."tokenId" = ANY(${banded}::text[])
          AND c."sampleKind" = ANY(${[...DEV_LAUNCH_GRADE_KINDS]})
          AND c."finalizedAt" IS NOT NULL AND c."finalizedAt" < ${builtAt}
        ORDER BY c."tokenId", c."anchorAt" ASC`
    : [];
  const gradeOf = new Map(grades.map((g) => [g.tokenId, g]));
  for (const t of counted) {
    const g = gradeOf.get(t.id);
    out.set(t.id, {
      launches: 1,
      inBand: t.firstInBandAt !== null && t.firstInBandAt.getTime() < builtAt.getTime() ? 1 : 0,
      graded: g ? 1 : 0,
      wins: g?.win ? 1 : 0,
      stops: g?.stop ? 1 : 0,
    });
  }
  return out;
}

/** Test hook. */
export function setDevLaunchBook(
  devs: [string, DevLaunchEntry][],
  families: [string, DevFamilyEntry][],
  market: DevLaunchMarket,
  builtAt: Date,
): void {
  book = { devs: new Map(devs), families: new Map(families), market, builtAt };
  loadedAt = Date.now();
}
