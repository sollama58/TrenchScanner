import {
  BODY_BOTTOM,
  BODY_TOP,
  BRAND_A,
  BRAND_B,
  CARD_W,
  FONT,
  INK,
  INK2,
  MUTED,
  PAD,
  cardCanvas,
  clip,
  frame,
  pill,
  roundRect,
} from "../shareCard";

/**
 * The Models tab's model share image: one model's chosen measure (2x, 4x or 10x rate, or average
 * return) day by day against the market's, and all four over the window beside it, in the shared
 * branded frame (shareCard.ts). It shows the record; the tab carries the caveats.
 */
export type CardMetric = "2x" | "4x" | "10x" | "ret";

export interface LearningCardData {
  model: string;
  windowDays: number;
  /** The measure the chart draws. */
  metric: CardMetric;
  /** Oldest first; null where the side had no graded calls that day. */
  points: { label: string; model: number | null; market: number | null }[];
  /** Its figures over the window, in percent: hit rates, and the average return per call. */
  rates: Record<CardMetric, number | null>;
  /** The market's figure for `metric` on the days it called. */
  market: number | null;
  graded: number;
}

const MARKET = "rgba(255, 255, 255, 0.55)";
const UP = "#34d399";
const DOWN = "#f87171";
const rate = (v: number | null) => (v === null ? "–" : `${v.toFixed(v >= 10 ? 0 : 1)}%`);
const signed = (v: number | null) =>
  v === null ? "–" : `${v > 0 ? "+" : v < 0 ? "-" : ""}${Math.abs(v).toFixed(Math.abs(v) >= 10 ? 0 : 1)}%`;
const show = (k: CardMetric, v: number | null) => (k === "ret" ? signed(v) : rate(v));
const SERIES: Record<CardMetric, string> = {
  "2x": "2x rate",
  "4x": "4x rate",
  "10x": "10x rate",
  ret: "avg return",
};

function chart(ctx: CanvasRenderingContext2D, d: LearningCardData, x0: number, x1: number) {
  const top = BODY_TOP + 62;
  const base = BODY_BOTTOM - 30;
  const h = base - top;
  const pts = d.points;
  const values = pts.flatMap((p) => [p.model, p.market]).filter((v): v is number => v !== null);
  const hi = Math.max(0, ...values) * 1.15;
  const low = d.metric === "ret" ? Math.min(0, ...values) * 1.15 : 0;
  const span = Math.max(10, hi - low);
  const step = span <= 30 ? 10 : span <= 60 ? 20 : span <= 125 ? 25 : span <= 250 ? 50 : 100;
  const max = Math.max(10, Math.ceil(hi / step) * step);
  const min = Math.floor(low / step) * step;
  const left = x0 + 62;
  const w = x1 - left;
  const x = (i: number) => left + (pts.length <= 1 ? w / 2 : (i / (pts.length - 1)) * w);
  const y = (v: number) => base - ((Math.min(max, Math.max(min, v)) - min) / (max - min)) * h;

  // Legend, above the plot.
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.font = `600 20px ${FONT}`;
  let lx = x0;
  const legend: [string, string][] = [
    [`${d.model} ${SERIES[d.metric]}`, BRAND_A],
    [`Market ${SERIES[d.metric]}`, MARKET],
  ];
  for (const [name, color] of legend) {
    ctx.fillStyle = color;
    roundRect(ctx, lx, BODY_TOP + 17, 28, 6, 3);
    ctx.fill();
    ctx.fillStyle = INK2;
    const label = clip(ctx, name, 330);
    ctx.fillText(label, lx + 38, BODY_TOP + 20);
    lx += 38 + ctx.measureText(label).width + 36;
  }

  // Grid and ticks.
  ctx.font = `500 16px ${FONT}`;
  for (let t = min; t <= max; t += step) {
    ctx.strokeStyle = t === 0 ? "rgba(255, 255, 255, 0.2)" : "rgba(255, 255, 255, 0.07)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(left, y(t));
    ctx.lineTo(x1, y(t));
    ctx.stroke();
    ctx.fillStyle = MUTED;
    ctx.textAlign = "right";
    ctx.fillText(d.metric === "ret" && t > 0 ? `+${t}%` : `${t}%`, left - 10, y(t));
  }
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  const every = Math.max(1, Math.ceil(pts.length / 7));
  pts.forEach((p, i) => {
    if (i % every !== 0 && i !== pts.length - 1) return;
    if (i !== pts.length - 1 && pts.length - 1 - i < every / 2) return;
    ctx.fillStyle = MUTED;
    ctx.fillText(p.label, x(i), base + 10);
  });

  const line = (
    pick: (p: (typeof pts)[number]) => number | null,
    stroke: string | CanvasGradient,
    width: number,
  ) => {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = width;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.beginPath();
    let pen = false;
    pts.forEach((p, i) => {
      const v = pick(p);
      if (v === null) {
        pen = false;
        return;
      }
      if (pen) ctx.lineTo(x(i), y(v));
      else ctx.moveTo(x(i), y(v));
      pen = true;
    });
    ctx.stroke();
    ctx.fillStyle = typeof stroke === "string" ? stroke : BRAND_A;
    pts.forEach((p, i) => {
      const v = pick(p);
      if (v === null) return;
      ctx.beginPath();
      ctx.arc(x(i), y(v), width + 1.5, 0, Math.PI * 2);
      ctx.fill();
    });
  };
  ctx.setLineDash([8, 7]);
  line((p) => p.market, MARKET, 2.5);
  ctx.setLineDash([]);
  const g = ctx.createLinearGradient(left, 0, x1, 0);
  g.addColorStop(0, BRAND_A);
  g.addColorStop(1, BRAND_B);
  line((p) => p.model, g, 4);
  ctx.textAlign = "left";
}

function side(ctx: CanvasRenderingContext2D, d: LearningCardData, x0: number) {
  const w = CARD_W - PAD - x0;
  const top = BODY_TOP + 6;
  ctx.fillStyle = "rgba(255, 255, 255, 0.05)";
  roundRect(ctx, x0, top, w, BODY_BOTTOM - top, 18);
  ctx.fill();
  const ix = x0 + 26;
  const iw = w - 52;
  const half = iw / 2;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";

  // All four figures, two by two; the one the chart draws in the brand gradient.
  const cells: [CardMetric, string][] = [
    ["2x", "hit 2x"],
    ["4x", "hit 4x"],
    ["10x", "hit 10x"],
    ["ret", "avg return"],
  ];
  cells.forEach(([k, label], i) => {
    const x = ix + half * (i % 2);
    const y = top + 66 + Math.floor(i / 2) * 102;
    const v = d.rates[k];
    if (k === d.metric) {
      const g = ctx.createLinearGradient(x, 0, x + 120, 0);
      g.addColorStop(0, "#b9a6ff");
      g.addColorStop(1, "#7fb2ff");
      ctx.fillStyle = g;
    } else ctx.fillStyle = k === "ret" && v !== null && v !== 0 ? (v > 0 ? UP : DOWN) : INK;
    ctx.font = `800 40px ${FONT}`;
    ctx.fillText(clip(ctx, show(k, v), half - 8), x, y);
    ctx.fillStyle = INK2;
    ctx.font = `500 18px ${FONT}`;
    ctx.fillText(clip(ctx, label, half - 8), x, y + 28);
  });

  // The chart's measure against the market, on the days it called.
  ctx.fillStyle = "rgba(255, 255, 255, 0.12)";
  ctx.fillRect(ix, BODY_BOTTOM - 64, iw, 1);
  const mine = d.rates[d.metric];
  const line =
    d.metric === "ret"
      ? `Market: ${signed(d.market)} a call`
      : mine !== null && d.market
        ? `${(mine / d.market).toFixed(1)}x the market's ${d.metric} rate`
        : `${d.graded.toLocaleString("en-US")} graded calls`;
  ctx.fillStyle = INK;
  ctx.font = `700 20px ${FONT}`;
  ctx.fillText(clip(ctx, line, iw), ix, BODY_BOTTOM - 26);
}

const SUB: Record<CardMetric, string> = {
  "2x": "How often its calls doubled, day by day, next to the market.",
  "4x": "How often its calls reached 4x, day by day, next to the market.",
  "10x": "How often its calls reached 10x, day by day, next to the market.",
  ret: "Its average return per call, day by day, next to the market.",
};

export async function renderLearningCard(d: LearningCardData): Promise<HTMLCanvasElement> {
  const { canvas, ctx, icon } = await cardCanvas();
  if (!ctx) return canvas;
  frame(ctx, icon, `${d.model}'s calls, day by day`, SUB[d.metric], {
    badge: (c, right, cy) => pill(c, right, cy, `Last ${d.windowDays} days`),
    footer: `${d.graded.toLocaleString("en-US")} live calls · market = a random pick from the same moments`,
    link: "trenchscanner.app",
  });
  const split = CARD_W - PAD - 372;
  if (d.points.length < 2) {
    ctx.fillStyle = MUTED;
    ctx.font = `500 24px ${FONT}`;
    ctx.textBaseline = "middle";
    ctx.fillText("Not enough graded days yet", PAD, (BODY_TOP + BODY_BOTTOM) / 2);
  } else chart(ctx, d, PAD, split - 40);
  side(ctx, d, split);
  return canvas;
}
