import { avatarHandle, createLogger, fetchXAvatar, prisma, type XAvatar } from "@trenchscanner/core";

const logger = createLogger("kol-avatars");

/**
 * Each KOL's X profile picture (user ask 2026-10-18), read after the daily roster refresh
 * (kolWalletsJob.ts) into KolAvatar, which the API serves at GET /kol-avatars/:handle. A picture is
 * read again once it is a week old, so a KOL who changes theirs shows the new one within a week.
 *
 * Handles never read go first, then the oldest. MAX_PER_RUN and the pause keep a run to a few
 * minutes and polite to FxTwitter; a large roster fills in over a few days. A failed read writes
 * nothing, so the handle is tried again next run; a run of failures in a row (an outage or a rate
 * limit) ends the run early. Pictures of handles gone from the roster are dropped.
 */

export const AVATAR_REFRESH_MS = 7 * 86_400_000;
const MAX_PER_RUN = 400;
const PAUSE_MS = 250;
const MAX_FAILS_IN_A_ROW = 5;

export interface KolAvatarRun {
  read: number;
  pictures: number;
  none: number;
  failed: number;
  removed: number;
}

/** The handles due a read, never-read first then oldest. Exported for tests. */
export function dueHandles(
  handles: readonly string[],
  stored: ReadonlyMap<string, Date>,
  now: number,
  max = MAX_PER_RUN,
): string[] {
  return handles
    .filter((h) => {
      const at = stored.get(h);
      return !at || now - at.getTime() >= AVATAR_REFRESH_MS;
    })
    .sort((a, b) => (stored.get(a)?.getTime() ?? 0) - (stored.get(b)?.getTime() ?? 0) || a.localeCompare(b))
    .slice(0, max);
}

export async function refreshKolAvatars(
  opts: {
    now?: () => number;
    pauseMs?: number;
    fetchAvatar?: (handle: string) => Promise<XAvatar>;
  } = {},
): Promise<KolAvatarRun> {
  const now = opts.now ?? Date.now;
  const pauseMs = opts.pauseMs ?? PAUSE_MS;
  const fetchAvatar = opts.fetchAvatar ?? ((h: string) => fetchXAvatar(h));
  const roster = await prisma.kolWallet.findMany({
    where: { twitter: { not: null } },
    select: { twitter: true },
  });
  const handles = [...new Set(roster.flatMap((r) => avatarHandle(r.twitter) ?? []))];
  const stored = await prisma.kolAvatar.findMany({ select: { handle: true, fetchedAt: true } });
  const keep = new Set(handles);
  const gone = stored.filter((s) => !keep.has(s.handle)).map((s) => s.handle);
  const removed = gone.length
    ? (await prisma.kolAvatar.deleteMany({ where: { handle: { in: gone } } })).count
    : 0;

  const due = dueHandles(handles, new Map(stored.map((s) => [s.handle, s.fetchedAt])), now());
  const run: KolAvatarRun = { read: 0, pictures: 0, none: 0, failed: 0, removed };
  let failsInARow = 0;
  for (const handle of due) {
    if (run.read + run.failed > 0 && pauseMs > 0) await new Promise((r) => setTimeout(r, pauseMs));
    let avatar: XAvatar;
    try {
      avatar = await fetchAvatar(handle);
    } catch (err) {
      run.failed += 1;
      failsInARow += 1;
      if (failsInARow >= MAX_FAILS_IN_A_ROW) {
        logger.warn("KOL picture reads failing; stopping this run", { handle, error: String(err) });
        break;
      }
      continue;
    }
    failsInARow = 0;
    run.read += 1;
    const row =
      avatar.status === "ok"
        ? { status: "ok", image: avatar.image, contentType: avatar.contentType, hash: avatar.hash }
        : { status: "none", image: null, contentType: null, hash: null };
    if (avatar.status === "ok") run.pictures += 1;
    else run.none += 1;
    const fetchedAt = new Date(now());
    await prisma.kolAvatar.upsert({
      where: { handle },
      create: { handle, ...row, fetchedAt },
      update: { ...row, fetchedAt },
    });
  }
  logger.info("KOL pictures refreshed", { due: due.length, ...run });
  return run;
}
