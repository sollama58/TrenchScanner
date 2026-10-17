import {
  BODY_BOTTOM,
  BODY_TOP,
  CARD_W,
  FONT,
  INK,
  INK2,
  MUTED,
  PAD,
  SERIES,
  cardCanvas,
  clip,
  frame,
  pill,
  roundRect,
} from "../shareCard";
import { drawPricingChange } from "../pricingChange";
import { lineScale, tickIndices } from "../chartScale";

/**
 * The Models tab's week share image: up to five picked models' chosen measure over the last seven
 * days, with the market and every model pooled always drawn, and each line's figure over the week
 * beside the chart, in the shared branded frame (shareCard.ts).
 */
export type CardMetric = "2x" | "4x" | "10x" | "ret" | "catch";

export interface WeekCardData {
  metric: CardMetric;
  /** One per day, oldest first. */
  labels: string[];
  /** tone: s1..s5 for a picked model, "all" for every model pooled, "ref" for the market. */
  lines: { label: string; tone: string; values: (number | null)[]; week: number | null }[];
  /** Graded calls across all models over the week. */
  graded: number;
  /** Where pricing changed, in points from the first day (pricingChangePoint). */
  pricingChange?: number | null;
}

const MARKET = "rgba(255, 255, 255, 0.55)";
const UP = "#34d399";
const DOWN = "#f87171";
const rate = (v: number | null) => (v === null ? "–" : `${v.toFixed(v >= 10 ? 0 : 1)}%`);
const signed = (v: number | null) =>
  v === null ? "–" : `${v > 0 ? "+" : v < 0 ? "-" : ""}${Math.abs(v).toFixed(Math.abs(v) >= 10 ? 0 : 1)}%`;

function colorOf(tone: string): string {
  if (tone === "ref") return MARKET;
  if (tone === "all") return INK;
  const slot = Number(tone.slice(1)) - 1;
  return SERIES[slot] ?? INK;
}

function chart(ctx: CanvasRenderingContext2D, d: WeekCardData, x0: number, x1: number) {
  const top = BODY_TOP + 14;
  const base = BODY_BOTTOM - 30;
  const h = base - top;
  const n = d.labels.length;
  const values = d.lines.flatMap((l) => l.values).filter((v): v is number => v !== null);
  // The Models tab's week lines' own scale (MultiLines), so the card reads like the chart.
  const { top: max, bottom: min, ticks } = lineScale(values, d.metric === "ret");
  const left = x0 + 62;
  const w = x1 - left;
  const x = (i: number) => left + (n <= 1 ? w / 2 : (i / (n - 1)) * w);
  const y = (v: number) => base - ((Math.min(max, Math.max(min, v)) - min) / (max - min)) * h;

  ctx.textBaseline = "middle";
  ctx.font = `500 16px ${FONT}`;
  for (const t of ticks) {
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
  ctx.textBaseline = "top";
  // Only the day labels that fit side by side, the last always (more days than fit would overlap).
  const labelW = Math.max(0, ...d.labels.map((l) => ctx.measureText(l).width));
  const shown = new Set(tickIndices(n, n <= 1 ? w : w / (n - 1), labelW, 12));
  d.labels.forEach((label, i) => {
    if (!shown.has(i)) return;
    ctx.fillStyle = MUTED;
    ctx.textAlign = i === 0 ? "left" : i === n - 1 ? "right" : "center";
    ctx.fillText(label, x(i), base + 10);
  });

  if (d.pricingChange != null && n > 1) drawPricingChange(ctx, x(d.pricingChange), top, base, FONT, x1);

  const line = (vals: (number | null)[], color: string, width: number) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.beginPath();
    let pen = false;
    vals.forEach((v, i) => {
      if (v === null) {
        pen = false;
        return;
      }
      if (pen) ctx.lineTo(x(i), y(v));
      else ctx.moveTo(x(i), y(v));
      pen = true;
    });
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = color;
    vals.forEach((v, i) => {
      if (v === null) return;
      ctx.beginPath();
      ctx.arc(x(i), y(v), width + 1.5, 0, Math.PI * 2);
      ctx.fill();
    });
  };
  // Yardsticks under the picked models.
  for (const l of d.lines.filter((l) => l.tone === "ref")) {
    ctx.setLineDash([8, 7]);
    line(l.values, MARKET, 2.5);
  }
  for (const l of d.lines.filter((l) => l.tone === "all")) line(l.values, INK, 3);
  for (const l of d.lines.filter((l) => l.tone !== "ref" && l.tone !== "all"))
    line(l.values, colorOf(l.tone), 3.5);
  ctx.textAlign = "left";
}

/** The legend and each line's figure over the week, one row per line. */
function side(ctx: CanvasRenderingContext2D, d: WeekCardData, x0: number) {
  const w = CARD_W - PAD - x0;
  const top = BODY_TOP + 6;
  const bottom = BODY_BOTTOM;
  ctx.fillStyle = "rgba(255, 255, 255, 0.05)";
  roundRect(ctx, x0, top, w, bottom - top, 18);
  ctx.fill();
  const ix = x0 + 22;
  const iw = w - 44;
  ctx.textBaseline = "middle";
  ctx.fillStyle = MUTED;
  ctx.font = `600 15px ${FONT}`;
  ctx.textAlign = "left";
  ctx.fillText("7-DAY FIGURE", ix, top + 26);
  const rows = d.lines;
  const rowH = Math.min(40, (bottom - top - 52) / Math.max(1, rows.length));
  rows.forEach((l, i) => {
    const cy = top + 52 + rowH * i + rowH / 2;
    const color = colorOf(l.tone);
    ctx.fillStyle = color;
    if (l.tone === "ref") {
      ctx.fillRect(ix, cy - 2, 8, 4);
      ctx.fillRect(ix + 12, cy - 2, 8, 4);
    } else {
      roundRect(ctx, ix, cy - 4, 20, 8, 4);
      ctx.fill();
    }
    const value = d.metric === "ret" ? signed(l.week) : rate(l.week);
    ctx.font = `800 22px ${FONT}`;
    const vw = ctx.measureText(value).width;
    ctx.fillStyle = d.metric === "ret" && l.week !== null && l.week !== 0 ? (l.week > 0 ? UP : DOWN) : INK;
    ctx.textAlign = "right";
    ctx.fillText(value, ix + iw, cy + 1);
    ctx.textAlign = "left";
    ctx.fillStyle = l.tone === "ref" || l.tone === "all" ? INK2 : INK;
    ctx.font = `${l.tone === "ref" || l.tone === "all" ? 500 : 600} 19px ${FONT}`;
    ctx.fillText(clip(ctx, l.label, iw - 34 - vw - 12), ix + 32, cy + 1);
  });
}

const SUB: Record<CardMetric, string> = {
  "2x": "How often each model's calls doubled within 15 min, before a 50% stop, next to the filtered market.",
  "4x": "How often each model's calls reached 4x within 30 min, before a 50% stop, next to the filtered market.",
  "10x":
    "How often each model's calls reached 10x within an hour, before a 50% stop, next to the filtered market.",
  ret: "Average return per call, day by day, next to the filtered market.",
  catch: "The share of each day's runners each model called at a winning moment, next to the catch goal.",
};

export async function renderWeekCard(d: WeekCardData): Promise<HTMLCanvasElement> {
  const { canvas, ctx, icon } = await cardCanvas();
  if (!ctx) return canvas;
  frame(ctx, icon, "Is it getting better?", SUB[d.metric], {
    badge: (c, right, cy) => pill(c, right, cy, `Last ${d.labels.length} days`),
    footer:
      d.metric === "catch"
        ? `${d.graded.toLocaleString("en-US")} live calls, graded rule 3+ · runner = a token that doubled cleanly that day`
        : `${d.graded.toLocaleString("en-US")} live calls, graded rule 3+ · filtered market = a random pick from the same screened moments`,
    link: "trenchscanner.app",
  });
  const split = CARD_W - PAD - 340;
  chart(ctx, d, PAD, split - 36);
  side(ctx, d, split);
  return canvas;
}
