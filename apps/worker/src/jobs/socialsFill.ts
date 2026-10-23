import {
  createLogger,
  forEachWithConcurrency,
  prisma,
  tokenSageSocials,
  type CandidateToken,
  type CoinSocials,
  type JupiterClient,
} from "@trenchscanner/core";

const logger = createLogger("socials-fill");

/** A coin's links as one source read them. */
export type MintSocials = CoinSocials & { mintAddress: string };

const LINKS = ["twitterUrl", "telegramUrl", "websiteUrl"] as const;
const BIT = { twitterUrl: "hasTwitter", telegramUrl: "hasTelegram", websiteUrl: "hasWebsite" } as const;

/**
 * The links of `sources` merged by priority: each link from the first source that has one.
 * Exported for tests.
 */
export function mergeSocials(...sources: (CoinSocials | undefined)[]): CoinSocials {
  const out: CoinSocials = {};
  for (const link of LINKS) {
    const url = sources.find((s) => s?.[link])?.[link];
    if (url) out[link] = url;
  }
  return out;
}

/**
 * Records the links a source found on the Token rows still missing them: each column is filled
 * only while it is null (a stored link is never replaced), and the matching has* bit is set true.
 * One read for the rows, one write for each row that gains a link. Returns the rows written.
 */
export async function recordSocialLinks(coins: readonly MintSocials[]): Promise<number> {
  const byMint = new Map<string, CoinSocials>();
  for (const c of coins) {
    if (!LINKS.some((l) => c[l])) continue;
    byMint.set(c.mintAddress, mergeSocials(byMint.get(c.mintAddress), c));
  }
  if (byMint.size === 0) return 0;
  const rows = await prisma.token.findMany({
    where: {
      mintAddress: { in: [...byMint.keys()] },
      OR: [{ twitterUrl: null }, { telegramUrl: null }, { websiteUrl: null }],
    },
    select: { id: true, mintAddress: true, twitterUrl: true, telegramUrl: true, websiteUrl: true },
  });
  let written = 0;
  await forEachWithConcurrency(rows, 4, async (row) => {
    const found = byMint.get(row.mintAddress);
    if (!found) return;
    const data: Record<string, string | boolean> = {};
    for (const link of LINKS) {
      const url = found[link];
      if (url && !row[link]) {
        data[link] = url;
        data[BIT[link]] = true;
      }
    }
    if (Object.keys(data).length === 0) return;
    await prisma.token
      .update({ where: { id: row.id }, data })
      .then(() => {
        written += 1;
      })
      .catch((err: unknown) =>
        logger.debug("failed to record social links", { mint: row.mintAddress, error: String(err) }),
      );
  });
  return written;
}

export interface SocialsFillStats {
  /** Coins with no link at all, asked about. */
  asked: number;
  /** Of those, the ones a source had a link for, by the source that gave the first link. */
  fromJupiter: number;
  fromTokenSage: number;
  /** Rows written (a link recorded). */
  recorded: number;
  /** Jupiter's search failed or ran out of its deadline. */
  failed: number;
}

const emptyStats = (): SocialsFillStats => ({
  asked: 0,
  fromJupiter: 0,
  fromTokenSage: 0,
  recorded: 0,
  failed: 0,
});
let stats = emptyStats();
let lastRunAt = Number.NEGATIVE_INFINITY;
let running = false;

/** The counts since the last call, for the scan's heartbeat. */
export function takeSocialsFillStats(): SocialsFillStats {
  const out = stats;
  stats = emptyStats();
  return out;
}

/** Test hook. */
export function resetSocialsFill(): void {
  stats = emptyStats();
  lastRunAt = Number.NEGATIVE_INFINITY;
  running = false;
}

/** How far back a coin that reached the band is still asked about: the launches of the Pump.fun block too. */
export const SOCIALS_FILL_WINDOW_MS = 48 * 3_600_000;
/** Coins asked about a run: two Jupiter searches (100 mints each). */
export const SOCIALS_FILL_PER_RUN = 200;
const MIN_INTERVAL_MS = 60_000;
const MIN_RECHECK_MS = 5 * 60_000;
const MAX_RECHECK_MS = 6 * 3_600_000;

export interface SocialsFillDeps {
  /** Jupiter's token search, which carries each coin's metadata links. Unset: TokenSage's reads alone. */
  jupiter?: Partial<Pick<JupiterClient, "getTokensByAddresses">>;
  /** The coins due a look (dueForSocials); tests bring their own. */
  due?: (now: Date, limit: number) => Promise<string[]>;
  /** The links in TokenSage's stored reads of `mints` (storedSageSocials); tests bring their own. */
  sage?: (mints: string[]) => Promise<MintSocials[]>;
  record?: (coins: readonly MintSocials[]) => Promise<number>;
  markChecked?: (mints: string[], at: Date) => Promise<unknown>;
}

/**
 * The socials of coins the cards and the token view show with no link at all (user bug report
 * 2026-10-23). Pump.fun was where launch metadata came from, and it has refused our servers since
 * 2026-10-22: from then on the X link was on about 20% of banked rows, against about 89% the day
 * before, and the X account inputs (nsX*) on 8% against 38%. Jupiter's token search reads each
 * coin's metadata JSON and lists its X, Telegram and website for any launchpad, 100 mints a call,
 * on the plan's own budget (no Helius or CoinGecko credits); TokenSage's stored reads carry the
 * links its own metadata read found. Each link from the first that has it.
 *
 * Asks about the coins that reached the band in the last 48 hours (so the launches of the block
 * are filled in too) and the coins someone has open, with no link recorded, at most
 * SOCIALS_FILL_PER_RUN a run and once a minute. A coin that still has none is asked again on a
 * backoff of a quarter of its time since entering the band, 5 minutes to 6 hours, so links added
 * after launch (a late DexScreener profile, Jupiter indexing late) are picked up. DexScreener's
 * paid profiles also reach the rows through its profile feed and the band refresh's info blocks.
 * Not awaited by the scan.
 */
export async function fillMissingSocials(deps: SocialsFillDeps, now = Date.now()): Promise<void> {
  if (running || now - lastRunAt < MIN_INTERVAL_MS) return;
  running = true;
  lastRunAt = now;
  try {
    const at = new Date(now);
    const mints = await (deps.due ?? dueForSocials)(at, SOCIALS_FILL_PER_RUN);
    if (mints.length === 0) return;
    stats.asked += mints.length;
    const fromJupiter = new Map<string, CoinSocials>();
    const unanswered = new Set<string>();
    if (deps.jupiter?.getTokensByAddresses) {
      const found = await deps.jupiter
        .getTokensByAddresses(mints, 1, {
          deadlineMs: 15_000,
          timeoutMs: 8_000,
          retries: 0,
          failed: unanswered,
        })
        .catch((err: unknown) => {
          logger.warn("jupiter socials lookup failed", { error: String(err) });
          for (const m of mints) unanswered.add(m);
          return [] as CandidateToken[];
        });
      for (const t of found) fromJupiter.set(t.mintAddress, linksOf(t));
      if (unanswered.size > 0) stats.failed += unanswered.size;
    }
    const fromSage = new Map(
      (await (deps.sage ?? storedSageSocials)(mints)).map((s) => [s.mintAddress, linksOf(s)]),
    );
    const merged: MintSocials[] = [];
    for (const mint of mints) {
      const jup = fromJupiter.get(mint);
      const sage = fromSage.get(mint);
      const links = mergeSocials(jup, sage);
      if (!LINKS.some((l) => links[l])) continue;
      if (jup && LINKS.some((l) => jup[l])) stats.fromJupiter += 1;
      else stats.fromTokenSage += 1;
      merged.push({ mintAddress: mint, ...links });
    }
    stats.recorded += await (deps.record ?? recordSocialLinks)(merged);
    // A coin Jupiter never answered for is asked again next run, unless TokenSage had its links.
    const withLinks = new Set(merged.map((m) => m.mintAddress));
    const checked = mints.filter((m) => withLinks.has(m) || !unanswered.has(m));
    if (checked.length > 0) await (deps.markChecked ?? markSocialsChecked)(checked, at);
  } finally {
    running = false;
  }
}

function linksOf(s: CoinSocials): CoinSocials {
  return mergeSocials({ twitterUrl: s.twitterUrl, telegramUrl: s.telegramUrl, websiteUrl: s.websiteUrl });
}

/**
 * The coins due a look, never-asked first then the longest since: in the band within the window
 * or open in a token view in the last ten minutes, no link recorded, and not asked within a
 * quarter of their time since entering the band (5 minutes to 6 hours).
 */
async function dueForSocials(now: Date, limit: number): Promise<string[]> {
  const since = new Date(now.getTime() - SOCIALS_FILL_WINDOW_MS);
  const viewed = new Date(now.getTime() - 10 * 60_000);
  const rows = await prisma.$queryRaw<{ mintAddress: string }[]>`
    SELECT t."mintAddress"
    FROM "Token" t
    WHERE (t."firstInBandAt" > ${since}::timestamp(3) OR t."lastViewedAt" > ${viewed}::timestamp(3))
      AND t."twitterUrl" IS NULL AND t."telegramUrl" IS NULL AND t."websiteUrl" IS NULL
      AND (
        t."socialsCheckedAt" IS NULL
        OR t."socialsCheckedAt" < ${now}::timestamp(3) - GREATEST(
          ${MIN_RECHECK_MS / 1000}::int * interval '1 second',
          LEAST(
            ${MAX_RECHECK_MS / 1000}::int * interval '1 second',
            (${now}::timestamp(3) - COALESCE(t."firstInBandAt", t."firstSeenAt")) / 4
          )
        )
      )
    ORDER BY t."socialsCheckedAt" ASC NULLS FIRST, t."firstInBandAt" DESC NULLS LAST
    LIMIT ${limit}`;
  return rows.map((r) => r.mintAddress);
}

async function storedSageSocials(mints: string[]): Promise<MintSocials[]> {
  const rows = await prisma.tokenNarrative.findMany({
    where: { mintAddress: { in: mints }, status: { not: "failed" } },
    select: { mintAddress: true, analysis: true },
  });
  return rows.map((r) => ({ mintAddress: r.mintAddress, ...tokenSageSocials(r.analysis) }));
}

async function markSocialsChecked(mints: string[], at: Date): Promise<void> {
  await prisma.token.updateMany({ where: { mintAddress: { in: mints } }, data: { socialsCheckedAt: at } });
}
