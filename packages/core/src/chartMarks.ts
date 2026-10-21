/**
 * Chart-mark kinds and the revision that turns an untouched older default into the current one.
 * The web (apps/web/src/appearance.ts) and the API (apps/api/src/feedAppearance.ts) both read a
 * saved look through reviseChartMarkKinds (user ask 2026-10-21: one shared revision, so the two
 * copies cannot drift). This file imports nothing, so the web can take it from the chartMarks
 * subpath without pulling in the rest of core.
 *
 * Revision 3 is the current default: risky wallets and winners are off. A look saved at revision
 * 3 keeps the list the reader saved, including risky and winner when they turned those back on.
 * A look saved earlier that is still exactly an older default (every kind, or every kind but
 * risky) drops the kinds that were still on by default then. A list the reader edited keeps what
 * they left.
 *
 * The caller filters unknown names first and chooses the order. This function does not reorder.
 */

export const CHART_MARK_KINDS = [
  "kol",
  "known",
  "funded",
  "probable",
  "dev",
  "risky",
  "winner",
  "linked",
] as const;

export type ChartMarkKind = (typeof CHART_MARK_KINDS)[number];

/** Which default chartMarkKinds a look was saved against. 3 turns winners off. */
export const CHART_MARKS_REV = 3;

/** The kinds marked by default: all but risky wallets, dumpers, and winners. */
export const DEFAULT_CHART_MARK_KINDS: readonly ChartMarkKind[] = CHART_MARK_KINDS.filter(
  (k) => k !== "risky" && k !== "winner",
);

/** Rev 2's default: every kind but risky, winners still on. */
const MARK_KINDS_BEFORE_WINNERS_OFF: readonly ChartMarkKind[] = CHART_MARK_KINDS.filter((k) => k !== "risky");

function sameMarkKinds(kinds: readonly string[], expected: readonly string[]): boolean {
  return kinds.length === expected.length && expected.every((k) => kinds.includes(k));
}

/**
 * The chart-mark list a saved look should read as. `chartMarksRev` is the revision stored with
 * the list; a missing revision is an older look.
 */
export function reviseChartMarkKinds(
  kinds: readonly ChartMarkKind[],
  chartMarksRev: unknown,
): ChartMarkKind[] {
  if (chartMarksRev === CHART_MARKS_REV) return [...kinds];
  // Every kind still on, and not saved after risky went off: the untouched old default.
  if (sameMarkKinds(kinds, CHART_MARK_KINDS) && chartMarksRev !== 2)
    return kinds.filter((k) => k !== "risky" && k !== "winner");
  // Rev 2's default (or risky switched back on against it): winners were still the default.
  if (sameMarkKinds(kinds, CHART_MARK_KINDS) || sameMarkKinds(kinds, MARK_KINDS_BEFORE_WINNERS_OFF))
    return kinds.filter((k) => k !== "winner");
  return [...kinds];
}
