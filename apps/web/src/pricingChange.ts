/**
 * When decisions started being priced from a seconds-old quote instead of DexScreener's
 * 45-60 s-old price (PR #382, live 2026-10-12 ~16:00 UTC), and history was re-graded to match.
 * Hit rates, catch rates and returns on either side of it are measured differently, so every
 * chart that trends them over time marks it (user request 2026-10-13).
 */
export const PRICING_CHANGE_AT = Date.parse("2026-10-12T16:00:00Z");
export const PRICING_CHANGE_LABEL = "Pricing Methods Changed";

/**
 * Where the change falls on an axis of time buckets, in bucket widths from the first bucket's
 * left edge (0 to n): bucket i spans [i, i + 1). A change in a gap between buckets sits on the
 * next bucket's left edge. Null when it is outside the buckets shown.
 */
export function pricingChangeSlot(
  starts: readonly number[],
  bucketMs: number,
  at: number = PRICING_CHANGE_AT,
): number | null {
  const n = starts.length;
  if (n === 0 || !(bucketMs > 0) || at < starts[0]! || at >= starts[n - 1]! + bucketMs) return null;
  for (let i = n - 1; i >= 0; i--) {
    if (starts[i]! <= at) return i + Math.min(1, (at - starts[i]!) / bucketMs);
  }
  return null;
}

/**
 * The same position on a line chart whose points sit at x = 0..n-1 (each point standing for its
 * whole bucket, centred on it): clamped to the drawn range.
 */
export function pricingChangePoint(starts: readonly number[], bucketMs: number): number | null {
  const slot = pricingChangeSlot(starts, bucketMs);
  if (slot === null) return null;
  return Math.min(Math.max(0, slot - 0.5), Math.max(0, starts.length - 1));
}

/** UTC day keys ("2026-10-12") as bucket starts. */
export const dayStarts = (keys: readonly string[]) => keys.map((k) => Date.parse(`${k}T00:00:00Z`));
export const DAY_MS = 86_400_000;

/** Bucket width from the starts themselves (the gap between neighbours), else the fallback. */
export function bucketMsOf(starts: readonly number[], fallbackMs: number): number {
  let best = Infinity;
  for (let i = 1; i < starts.length; i++) best = Math.min(best, starts[i]! - starts[i - 1]!);
  return Number.isFinite(best) && best > 0 ? best : fallbackMs;
}

/** The marker on a share card: a dashed vertical line from top to base, labelled at the top. */
export function drawPricingChange(
  ctx: CanvasRenderingContext2D,
  x: number,
  top: number,
  base: number,
  font: string,
  right: number,
): void {
  ctx.save();
  ctx.strokeStyle = "rgba(255, 255, 255, 0.6)";
  ctx.lineWidth = 2;
  ctx.setLineDash([7, 6]);
  ctx.beginPath();
  ctx.moveTo(x, top);
  ctx.lineTo(x, base);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.font = `600 14px ${font}`;
  ctx.textBaseline = "top";
  const w = ctx.measureText(PRICING_CHANGE_LABEL).width;
  const flip = x + 8 + w > right;
  ctx.textAlign = flip ? "right" : "left";
  ctx.fillStyle = "rgba(255, 255, 255, 0.8)";
  ctx.fillText(PRICING_CHANGE_LABEL, flip ? x - 8 : x + 8, top + 2);
  ctx.restore();
}
