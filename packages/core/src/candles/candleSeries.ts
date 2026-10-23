import { isDrawableBar, type StoredBar } from "./candleChunk.js";

/**
 * One timeframe's bars from every width the store (and the live edge) holds for a stretch (charts
 * audit 2026-10-22, target design): each moment is read from the finest width that covers it, and
 * those bars are folded into `tf`-wide bars. Where only bars wider than `tf` cover a stretch, they
 * are passed through at their own width, marked coarse, so a chart can shade them instead of
 * mixing sizes silently or dropping them (CH-2). Pure.
 */

/** Bars of one width from one source, covering [coverFrom, coverTo) without a break. */
export interface SeriesInput {
  /** Bar width in seconds. */
  res: number;
  coverFrom: number;
  coverTo: number;
  bars: readonly StoredBar[];
  /** Of two sources' bars at the same width and start, the higher priority's stands. */
  priority: number;
}

/** A served bar: `tf` wide, or, marked coarse, wider (`w` seconds: its real width). */
export interface SeriesBar extends StoredBar {
  coarse?: true;
  w?: number;
}

type Span = [number, number];

/** Spans joined where they touch or overlap, oldest first. */
export function unionSpans(spans: readonly Span[]): Span[] {
  const sorted = spans.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const out: Span[] = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** `spans` with every part inside `cut` taken out (both unions, oldest first). */
export function subtractSpans(spans: readonly Span[], cut: readonly Span[]): Span[] {
  const out: Span[] = [];
  for (const [a0, b] of spans) {
    let a = a0;
    for (const [c, d] of cut) {
      if (d <= a || c >= b) continue;
      if (c > a) out.push([a, c]);
      a = Math.max(a, d);
      if (a >= b) break;
    }
    if (a < b) out.push([a, b]);
  }
  return out;
}

/**
 * Which width each stretch is read from, clipped to [from, to). Sources no wider than the
 * timeframe (`tfSec`) claim their covers first, the most trusted (priority) first and, among
 * equals, the finest: any of them folds into the same `tf` bars, so the one whose bars are complete
 * should stand, not the finest. A finer source that is not complete used to win anyway: the live
 * tail's 1-second bars, with no volume and only the last 20 minutes of ticks, took a whole open
 * chart's stretch from Pump.fun's minute page and left it flat (chart gaps audit 2026-10-23). What
 * is left then goes to the wider sources, finest first, to be served coarse.
 */
export function baseSegments(
  inputs: readonly SeriesInput[],
  from = -Infinity,
  to = Infinity,
  tfSec = Infinity,
): { res: number; from: number; to: number }[] {
  const order = [...inputs].sort((a, b) => {
    const fitA = a.res <= tfSec;
    const fitB = b.res <= tfSec;
    if (fitA !== fitB) return fitA ? -1 : 1;
    if (fitA && a.priority !== b.priority) return b.priority - a.priority;
    return a.res - b.res || b.priority - a.priority;
  });
  let claimed: Span[] = [];
  const out: { res: number; from: number; to: number }[] = [];
  for (const input of order) {
    const cover: Span[] = unionSpans([[Math.max(input.coverFrom, from), Math.min(input.coverTo, to)]]);
    for (const [a, b] of subtractSpans(cover, claimed)) out.push({ res: input.res, from: a, to: b });
    claimed = unionSpans([...claimed, ...cover]);
  }
  return out.sort((x, y) => x.from - y.from);
}

/** Bars folded into one: the first open, the last close, the extremes, the volumes summed. */
function fold(t: number, bars: readonly StoredBar[]): StoredBar {
  const known = bars.filter((b) => b.vol !== null);
  return {
    t,
    o: bars[0]!.o,
    h: Math.max(...bars.map((b) => b.h)),
    l: Math.min(...bars.map((b) => b.l)),
    c: bars[bars.length - 1]!.c,
    vol: known.length > 0 ? known.reduce((s, b) => s + b.vol!, 0) : null,
  };
}

/**
 * The `tfSec`-wide bars over [from, to) (bar starts), oldest first. Each stretch is read from the
 * source baseSegments picks for it, and every source's bars of that width fill it (one source's
 * missing interval is another's bar); a width no wider than `tf` is folded into `tf` buckets
 * (every stored width divides the timeframes it is folded into), a wider one is passed through
 * marked coarse with its width. Where a coarse bar and a folded one would start together, the
 * folded one stands.
 */
export function candleSeries(
  inputs: readonly SeriesInput[],
  tfSec: number,
  from = -Infinity,
  to = Infinity,
): SeriesBar[] {
  const tf = tfSec * 1_000;
  // Per width, one bar per start: the highest priority's.
  const byRes = new Map<number, Map<number, { bar: StoredBar; priority: number }>>();
  for (const input of inputs) {
    let slots = byRes.get(input.res);
    if (!slots) byRes.set(input.res, (slots = new Map()));
    for (const bar of input.bars) {
      if (!isDrawableBar(bar)) continue;
      const held = slots.get(bar.t);
      if (!held || input.priority > held.priority) slots.set(bar.t, { bar, priority: input.priority });
    }
  }
  const buckets = new Map<number, StoredBar[]>();
  const coarse = new Map<number, SeriesBar>();
  for (const seg of baseSegments(inputs, from, to, tfSec)) {
    const slots = byRes.get(seg.res);
    if (!slots) continue;
    const width = seg.res * 1_000;
    for (const { bar } of slots.values()) {
      if (width <= tf) {
        if (bar.t < seg.from || bar.t >= seg.to) continue;
        const at = Math.floor(bar.t / tf) * tf;
        const list = buckets.get(at);
        if (list) list.push(bar);
        else buckets.set(at, [bar]);
        continue;
      }
      if (bar.t >= seg.to || bar.t + width <= seg.from) continue;
      // A wide bar the stretch starts inside of (a finer source's cover ended mid-bar) is served
      // from the stretch's start, the rest of its width: dropped, its minutes were drawn flat.
      const at = bar.t >= seg.from ? bar.t : Math.ceil(seg.from / tf) * tf;
      const w = (bar.t + width - at) / 1_000;
      if (w <= 0) continue;
      coarse.set(at, { ...bar, t: at, coarse: true, w });
    }
  }
  const out: SeriesBar[] = [];
  for (const [at, list] of buckets)
    out.push(
      fold(
        at,
        list.sort((a, b) => a.t - b.t),
      ),
    );
  for (const [at, bar] of coarse) if (!buckets.has(at)) out.push(bar);
  return out.sort((a, b) => a.t - b.t);
}
