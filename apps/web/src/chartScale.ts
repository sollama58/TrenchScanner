/**
 * Axis arithmetic the hand-drawn charts share (TrendChart, MultiLines, the week share card): round
 * scales, which tick labels fit, and numbers short enough for a narrow axis. Pure, so the tests
 * cover it without a browser.
 */

/**
 * Round axis bounds and ticks around the data: a step of 1, 2, 2.5 or 5 times a power of ten. With
 * `integer`, for counts, the step is a whole 1, 2 or 5 times a power of ten and never under 1, so
 * no two ticks round to the same count.
 */
export function niceScale(
  lo: number,
  hi: number,
  ticks = 4,
  integer = false,
): { min: number; max: number; step: number } {
  if (hi <= lo) hi = lo + 1;
  const raw = (hi - lo) / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = integer
    ? Math.max(1, (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag)
    : (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  return { min: Math.floor(lo / step) * step, max: Math.ceil(hi / step) * step, step };
}

/** The tick values of a scale, bottom to top, rounded so float steps don't print 0.30000000000000004. */
export function scaleTicks(sc: { min: number; max: number; step: number }): number[] {
  const out: number[] = [];
  for (let t = sc.min; t <= sc.max + sc.step / 1e6; t += sc.step) out.push(Number(t.toFixed(6)));
  return out;
}

/**
 * The y-scale of a chart of rates as lines (MultiLines, the week card): fitted to the data with
 * headroom rather than running to 100%, on a step of 10, 20, 25, 50 or 100 points, and through
 * zero when `signed` lets values go negative.
 */
export function lineScale(
  values: number[],
  signed: boolean,
): { top: number; bottom: number; step: number; ticks: number[] } {
  const hi = Math.max(0, ...values) * 1.15;
  const low = signed ? Math.min(0, ...values) * 1.15 : 0;
  const span = Math.max(10, hi - low);
  const step = span <= 30 ? 10 : span <= 60 ? 20 : span <= 125 ? 25 : span <= 250 ? 50 : 100;
  const top = Math.max(10, Math.ceil(hi / step) * step);
  const bottom = Math.floor(low / step) * step;
  // Up to `top` only: when every value is negative, `top` is the 10% floor, short of a whole step.
  const ticks = Array.from({ length: Math.floor((top - bottom) / step) + 1 }, (_, i) => bottom + i * step);
  return { top, bottom, step, ticks };
}

/** A count short enough for an axis: whole under ten thousand, then 12K, 1.25M, 3.4B. */
export function compactNumber(v: number): string {
  const a = Math.abs(v);
  if (a < 10_000) return Math.round(v).toLocaleString();
  const [div, suffix] = a >= 1e9 ? [1e9, "B"] : a >= 1e6 ? [1e6, "M"] : [1e3, "K"];
  const x = v / div;
  const digits = Math.abs(x) >= 100 ? 0 : Math.abs(x) >= 10 ? 1 : 2;
  return `${Number(x.toFixed(digits))}${suffix}`;
}

/** About how wide an 11px monospace tick label is, in pixels. */
export const tickTextWidth = (s: string, px = 11) => s.length * px * 0.62;

/**
 * Which of `n` evenly spaced points get a tick label `labelW` wide, `slot` apart: every k-th
 * point, so the labels stay evenly spaced in time, plus the last, leaving out the k-th ones that
 * would run into the last or (for the first) into the next. The first label is drawn from its
 * point rightwards, the last leftwards from its point, the rest centered on theirs.
 */
export function tickIndices(n: number, slot: number, labelW: number, gap = 6): number[] {
  if (n <= 0) return [];
  if (n === 1) return [0];
  const every = Math.max(1, Math.ceil((labelW + gap) / Math.max(1e-6, slot)));
  const extent = (i: number): [number, number] => {
    const c = i * slot;
    return i === 0 ? [c, c + labelW] : i === n - 1 ? [c - labelW, c] : [c - labelW / 2, c + labelW / 2];
  };
  const lastLeft = extent(n - 1)[0];
  const out: number[] = [];
  for (let i = 0; i < n - 1; i += every) if (extent(i)[1] <= lastLeft - gap) out.push(i);
  // The first label reaches a whole label right of its point, so it can meet the second.
  if (out.length > 1 && out[0] === 0 && extent(0)[1] + gap > extent(out[1]!)[0]) out.shift();
  out.push(n - 1);
  return out;
}

/**
 * Where a readout box `half` px either side of its center sits over a point at `x` in a chart
 * `width` wide: on the point, but pulled in so it never runs off the chart (or a phone's screen).
 */
export const tipCenter = (x: number, width: number, half = 120) =>
  Math.min(Math.max(x, half), Math.max(half, width - half));
