import {
  bubbleReadingOf,
  prisma,
  saveBubbleMoment,
  unpackBubbleReading,
  type BubbleMomentKind,
  type BubbleReading,
} from "@trenchscanner/core";
import { withCarriedHolderList } from "./curatedFeed.js";

/**
 * A bubble map kept at a moment other than the first model call (BubbleMapMoment, user ask
 * 2026-10-16), as GET /tokens/:mint/bubble-holders sends it (web src/bubbleMap.ts BubbleMoment).
 */
export interface BubbleMomentView {
  id: string;
  /** "screen": the first safety-screen pass inside the band. "filter": a filter's first catch, opened. */
  kind: BubbleMomentKind;
  /** The passing scan, or the filter's match. */
  at: string;
  /** When the reading was taken. */
  readAt: string;
  /** The reader's own filter caught it. */
  mine: boolean;
  /** A public filter's catch (a screen pass is everyone's too, and says so by its kind). */
  isPublic: boolean;
  /** The filter's name, for a filter's moment; null when the filter is gone. */
  filterName: string | null;
  reading: BubbleReading;
}

/**
 * The coin's kept moments `userId` may see, oldest first: every screen pass and public filter's
 * catch, and the reader's own filter's catch. A row that points at another's identical reading
 * (sameAsId) is sent with that reading; one whose reading can no longer be read is left out.
 */
export async function readBubbleMoments(
  mintAddress: string,
  userId: string | undefined,
): Promise<BubbleMomentView[]> {
  const rows = await prisma.bubbleMapMoment.findMany({
    where: { mintAddress, OR: [{ isPublic: true }, ...(userId ? [{ userId }] : [])] },
    orderBy: { momentAt: "asc" },
  });
  if (rows.length === 0) return [];
  const missing = rows.flatMap((r) =>
    r.reading === null && r.sameAsId && !rows.some((o) => o.id === r.sameAsId) ? [r.sameAsId] : [],
  );
  const filterIds = [...new Set(rows.flatMap((r) => (r.filterId ? [r.filterId] : [])))];
  const [targets, filters] = await Promise.all([
    missing.length > 0
      ? prisma.bubbleMapMoment.findMany({
          where: { id: { in: missing } },
          select: { id: true, reading: true },
        })
      : [],
    filterIds.length > 0
      ? prisma.userFilter.findMany({ where: { id: { in: filterIds } }, select: { id: true, name: true } })
      : [],
  ]);
  const textOf = new Map<string, string | null>([
    ...rows.map((r) => [r.id, r.reading] as const),
    ...targets.map((t) => [t.id, t.reading] as const),
  ]);
  const nameOf = new Map(filters.map((f) => [f.id, f.name]));
  return rows.flatMap((r) => {
    const reading = unpackBubbleReading(r.reading ?? (r.sameAsId ? textOf.get(r.sameAsId) : null));
    if (!reading) return [];
    return [
      {
        id: r.id,
        kind: r.kind as BubbleMomentKind,
        at: r.momentAt.toISOString(),
        readAt: r.readAt.toISOString(),
        mine: r.kind === "filter" && !!userId && r.userId === userId,
        isPublic: r.isPublic,
        filterName: r.filterId ? (nameOf.get(r.filterId) ?? null) : null,
        reading,
      },
    ];
  });
}

/** Why keepFilterMoment kept nothing, or "kept". */
export type FilterMomentResult = "kept" | "not_yours" | "public_kept" | "already_kept" | "no_reading";

/**
 * Keeps the coin's map at `userId`'s filter's first catch of it, now that they have opened one of
 * their alerts on it (`matchId`, POST /tokens/:mint/bubble-moments/filter): the reading of that
 * first match's own snapshot. Shown only to them, or to everyone when the filter was public (shared
 * on the leaderboard); once a public filter's catch is kept, no one else's is.
 */
export async function keepFilterMoment(
  mintAddress: string,
  userId: string,
  matchId: string,
): Promise<FilterMomentResult> {
  const opened = await prisma.match.findFirst({
    where: { id: matchId, userId, token: { mintAddress } },
    select: { tokenId: true },
  });
  if (!opened) return "not_yours";
  const [publicKept, own] = await Promise.all([
    prisma.bubbleMapMoment.findFirst({
      where: { mintAddress, kind: "filter", isPublic: true },
      select: { id: true },
    }),
    prisma.bubbleMapMoment.findUnique({
      where: { mintAddress_kind_userId: { mintAddress, kind: "filter", userId } },
      select: { id: true },
    }),
  ]);
  if (publicKept) return "public_kept";
  if (own) return "already_kept";
  // The user's first catch of the coin, whichever of their filters made it.
  const first = await prisma.match.findFirst({
    where: { userId, tokenId: opened.tokenId },
    orderBy: { matchedAt: "asc" },
    select: {
      matchedAt: true,
      filterId: true,
      filter: { select: { shareOnLeaderboard: true } },
      snapshot: true,
    },
  });
  if (!first) return "not_yours";
  const snapshot = await withCarriedHolderList(first.snapshot);
  const reading = snapshot ? bubbleReadingOf(snapshot) : null;
  if (!snapshot || !reading) return "no_reading";
  const kept = await saveBubbleMoment({
    mintAddress,
    kind: "filter",
    userId,
    filterId: first.filterId,
    isPublic: first.filter.shareOnLeaderboard,
    momentAt: first.matchedAt,
    readAt: snapshot.takenAt,
    reading,
  });
  return kept ? "kept" : "already_kept";
}
