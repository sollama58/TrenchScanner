/**
 * The words around a model call's quoted 2x rate (program audit 2026-11-28, EX-21).
 *
 * The API sends the rate the site's card quotes (CuratedAlert.shownPct, as `calibratedPct`). From
 * CARD_BAND_MIN_PCT up it is the share of the model's recent alerts ranked like this one that
 * doubled; under it, it is the model's rate over all its recent alerts, which is what nearly every
 * call carries. The extension printed either as a bare "Gems 20%" and called it "odds to 2x": the
 * chance for this coin, which the pooled rate is not. The site settled these words on 2026-11-02
 * and 2026-11-11 (apps/web/src/rates.ts calibratedRateLabel); this mirrors them.
 */
export const CARD_BAND_MIN_PCT = 35;

/** For a badge, a tag or a notification title: "20% recent 2x", "41% like it 2x". */
export function quotedRateShort(pct: number): string {
  const n = Math.round(pct);
  return n >= CARD_BAND_MIN_PCT ? `${n}% like it 2x` : `${n}% recent 2x`;
}

/** For a tooltip line: "20% of its recent alerts 2x'd", "41% of alerts like it 2x'd". */
export function quotedRateLong(pct: number): string {
  const n = Math.round(pct);
  return n >= CARD_BAND_MIN_PCT ? `${n}% of alerts like it 2x'd` : `${n}% of its recent alerts 2x'd`;
}

/** A model's name with its quoted rate, "Gems · 20% recent 2x"; the name alone without a rate. */
export function namedRate(name: string, pct: number | null): string {
  return pct === null ? name : `${name} · ${quotedRateShort(pct)}`;
}
