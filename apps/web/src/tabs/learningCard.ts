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
 * The Models tab's learning share image: one model's 2x rate day by day against the market rate,
 * with its edge over the market lately and before, in the shared branded frame (shareCard.ts).
 */
export interface LearningCardData {
  model: string;
  windowDays: number;
  /** Oldest first; null where the side had no graded calls that day. */
  points: { label: string; model: number | null; market: number | null }[];
  spanDays: number;
  recentLift: number | null;
  priorLift: number | null;
  verdict: string;
  /** "met" / "early" / "below": the verdict's tone. */
  tone: "met" | "early" | "below";
  graded: number;
}

const MARKET = "rgba(255, 255, 255, 0.55)";
const TONE: Record<LearningCardData["tone"], string> = { met: "#34d399", early: "#fbbf24", below: "#f87171" };

function chart(ctx: CanvasRenderingContext2D, d: LearningCardData, x0: number, x1: number) {
  const top = BODY_TOP + 62;
  const base = BODY_BOTTOM - 30;
  const h = base - top;
  const pts = d.points;
  const values = pts.flatMap((p) => [p.model, p.market]).filter((v): v is number => v !== null);
  const max = Math.max(10, Math.ceil((Math.max(0, ...values) * 1.15) / 10) * 10);
  const step = max <= 30 ? 10 : max <= 60 ? 20 : 25;
  const left = x0 + 52;
  const w = x1 - left;
  const x = (i: number) => left + (pts.length <= 1 ? w / 2 : (i / (pts.length - 1)) * w);
  const y = (v: number) => base - (Math.min(max, Math.max(0, v)) / max) * h;

  // Legend, above the plot.
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.font = `600 20px ${FONT}`;
  let lx = x0;
  const legend: [string, string][] = [
    [d.model, BRAND_A],
    ["Market rate", MARKET],
  ];
  for (const [name, color] of legend) {
    ctx.fillStyle = color;
    roundRect(ctx, lx, BODY_TOP + 17, 28, 6, 3);
    ctx.fill();
    ctx.fillStyle = INK2;
    const label = clip(ctx, name, 300);
    ctx.fillText(label, lx + 38, BODY_TOP + 20);
    lx += 38 + ctx.measureText(label).width + 36;
  }

  // Grid and ticks.
  ctx.font = `500 16px ${FONT}`;
  for (let t = 0; t <= max; t += step) {
    ctx.strokeStyle = t === 0 ? "rgba(255, 255, 255, 0.2)" : "rgba(255, 255, 255, 0.07)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(left, y(t));
    ctx.lineTo(x1, y(t));
    ctx.stroke();
    ctx.fillStyle = MUTED;
    ctx.textAlign = "right";
    ctx.fillText(`${t}%`, left - 10, y(t));
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
  ctx.fillStyle = "rgba(255, 255, 255, 0.05)";
  roundRect(ctx, x0, BODY_TOP + 6, w, BODY_BOTTOM - BODY_TOP - 6, 18);
  ctx.fill();
  const ix = x0 + 26;
  const iw = w - 52;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  const big = ctx.createLinearGradient(ix, 0, ix + 200, 0);
  big.addColorStop(0, "#b9a6ff");
  big.addColorStop(1, "#7fb2ff");
  ctx.fillStyle = big;
  ctx.font = `800 76px ${FONT}`;
  ctx.fillText(d.recentLift === null ? "–" : `${d.recentLift.toFixed(1)}x`, ix - 2, BODY_TOP + 84);
  ctx.fillStyle = INK2;
  ctx.font = `500 19px ${FONT}`;
  ctx.fillText(clip(ctx, "the market rate,", iw), ix, BODY_TOP + 116);
  ctx.fillText(clip(ctx, `last ${d.spanDays} days`, iw), ix, BODY_TOP + 140);

  ctx.fillStyle = INK;
  ctx.font = `700 30px ${FONT}`;
  ctx.fillText(d.priorLift === null ? "–" : `${d.priorLift.toFixed(1)}x`, ix, BODY_TOP + 198);
  ctx.fillStyle = INK2;
  ctx.font = `500 19px ${FONT}`;
  ctx.fillText(clip(ctx, `the ${d.spanDays} days before`, iw), ix, BODY_TOP + 226);

  ctx.fillStyle = TONE[d.tone];
  ctx.font = `700 26px ${FONT}`;
  ctx.fillText(clip(ctx, d.verdict, iw), ix, BODY_BOTTOM - 26);
}

export async function renderLearningCard(d: LearningCardData): Promise<HTMLCanvasElement> {
  const { canvas, ctx, icon } = await cardCanvas();
  if (!ctx) return canvas;
  const sub =
    d.recentLift === null
      ? `How often its calls doubled, day by day, vs a random pick from the same moments.`
      : `Its calls doubled ${d.recentLift.toFixed(1)}x as often as a random pick from the same moments.`;
  frame(ctx, icon, `Is ${d.model} getting better?`, sub, {
    badge: (c, right, cy) => pill(c, right, cy, `Last ${d.windowDays} days`),
    footer: `${d.graded.toLocaleString("en-US")} live calls, each graded on a 2x within 15 minutes`,
    link: "trenchscanner.app",
  });
  const split = CARD_W - PAD - 300;
  if (d.points.length < 2) {
    ctx.fillStyle = MUTED;
    ctx.font = `500 24px ${FONT}`;
    ctx.textBaseline = "middle";
    ctx.fillText("Not enough graded days yet", PAD, (BODY_TOP + BODY_BOTTOM) / 2);
  } else chart(ctx, d, PAD, split - 40);
  side(ctx, d, split);
  return canvas;
}
