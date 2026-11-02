import type { ModelsVsKols } from "../api";
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
  TRACK,
  cardCanvas,
  clip,
  frame,
  pill,
  roundRect,
} from "../shareCard";
import { MIN_GRADED_FOR_RATE } from "../rates";
import {
  KOL_ID,
  MIN_KOLS_TO_LEAD,
  TIERS,
  edge,
  kolAt,
  kolRate,
  leaderOf,
  rateOf,
  rateText,
  sideTotal,
  tiersAt,
  windowName,
  type Tier,
} from "./vsKolsView";

/**
 * The share image of the Models tab's "Models vs KOLs": the top three models and the typical KOL
 * (the median of the KOLs with enough picks), a row each, with their 2x, 4x and 10x rates over one
 * window, and the models together against the typical KOL on the right, in the shared branded
 * frame (shareCard.ts).
 */

const MODELS = SERIES[0]!;
const KOLS = SERIES[1]!;
const LEAD = "#34d399";

/** A row of the table: a model, or the typical KOL. */
interface CardRow {
  id: string;
  color: string;
  glyph: string;
  name: string;
  sub: string;
  rate: (tier: Tier) => { pct: number | null; thin: boolean };
}

function mark(ctx: CanvasRenderingContext2D, row: CardRow, cx: number, cy: number) {
  ctx.fillStyle = row.color;
  ctx.beginPath();
  ctx.arc(cx, cy, 15, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = INK;
  ctx.font = `800 15px ${FONT}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(row.glyph, cx, cy + 1);
  ctx.textAlign = "left";
}

function rowsOf(d: ModelsVsKols, days: number): { models: CardRow[]; kol: CardRow } {
  const k = kolAt(d.kol, days);
  return {
    models: d.models.map((m, i) => {
      const t = tiersAt(m, days);
      return {
        id: m.id,
        color: MODELS,
        glyph: String(i + 1),
        name: m.name,
        sub: `${(t?.graded ?? 0).toLocaleString("en-US")} graded calls`,
        rate: (tier) => {
          const r = rateOf(t, tier);
          return { pct: r.pct, thin: r.n < MIN_GRADED_FOR_RATE };
        },
      };
    }),
    kol: {
      id: KOL_ID,
      color: KOLS,
      glyph: "K",
      name: "The typical KOL",
      sub:
        k && k.kols > 0
          ? `median of ${k.kols} KOL${k.kols === 1 ? "" : "s"} with ${k.minPicks}+ picks`
          : "no KOL has enough picks yet",
      rate: (tier) => ({ pct: kolRate(k, tier).shown, thin: (k?.kols ?? 0) < MIN_KOLS_TO_LEAD }),
    },
  };
}

function table(ctx: CanvasRenderingContext2D, d: ModelsVsKols, days: number, x0: number, x1: number) {
  const { models, kol } = rowsOf(d, days);
  const rows = [...models, kol];
  const nameW = 300;
  const colW = (x1 - x0 - nameW) / TIERS.length;
  const top = BODY_TOP + 14;
  const headH = 30;
  const gap = models.length ? 18 : 0;
  const rowH = Math.min(58, (BODY_BOTTOM - top - headH - gap) / Math.max(1, rows.length));

  ctx.textBaseline = "middle";
  ctx.font = `700 15px ${FONT}`;
  ctx.fillStyle = MUTED;
  ctx.fillText(`LAST ${windowName(days).toUpperCase()}`, x0, top + headH / 2);
  TIERS.forEach((t, i) => {
    ctx.textAlign = "right";
    ctx.fillText(t.toUpperCase(), x0 + nameW + colW * (i + 1) - 8, top + headH / 2);
  });
  ctx.textAlign = "left";

  const kt = kolAt(d.kol, days);
  const leaders = new Map(TIERS.map((t) => [t, leaderOf(d.models, kt, days, t, MIN_GRADED_FOR_RATE)]));
  let y = top + headH;
  rows.forEach((row, i) => {
    if (i === models.length && i > 0) {
      ctx.fillStyle = "rgba(255, 255, 255, 0.1)";
      ctx.fillRect(x0, y + gap / 2, x1 - x0, 1);
      y += gap;
    }
    const cy = y + rowH / 2;
    mark(ctx, row, x0 + 15, cy);
    ctx.fillStyle = INK;
    ctx.font = `650 19px ${FONT}`;
    ctx.fillText(clip(ctx, row.name, nameW - 60), x0 + 42, cy - 10);
    ctx.fillStyle = MUTED;
    ctx.font = `500 14px ${FONT}`;
    ctx.fillText(clip(ctx, row.sub, nameW - 50), x0 + 42, cy + 12);
    TIERS.forEach((tier, c) => {
      const r = row.rate(tier);
      const right = x0 + nameW + colW * (c + 1) - 8;
      const lead = leaders.get(tier) === row.id;
      const text = rateText(r.pct);
      ctx.font = `800 26px ${FONT}`;
      const tw = ctx.measureText(text).width;
      if (lead) {
        ctx.fillStyle = "rgba(52, 211, 153, 0.16)";
        roundRect(ctx, right - tw - 14, cy - 18, tw + 22, 36, 10);
        ctx.fill();
      }
      ctx.fillStyle = lead ? LEAD : r.thin ? MUTED : INK;
      ctx.textAlign = "right";
      ctx.fillText(text, right - 3, cy + 1);
      ctx.textAlign = "left";
    });
    y += rowH;
  });
}

/** The models together against the typical KOL: one bar pair per tier. */
function duel(ctx: CanvasRenderingContext2D, d: ModelsVsKols, days: number, x0: number) {
  const w = CARD_W - PAD - x0;
  const top = BODY_TOP + 6;
  const bottom = BODY_BOTTOM;
  ctx.fillStyle = "rgba(255, 255, 255, 0.05)";
  roundRect(ctx, x0, top, w, bottom - top, 18);
  ctx.fill();
  const ix = x0 + 22;
  const iw = w - 44;
  const m = sideTotal(d.models, days);
  const k = kolAt(d.kol, days);
  const kolThin = (k?.kols ?? 0) < MIN_KOLS_TO_LEAD;
  ctx.textBaseline = "middle";
  ctx.fillStyle = MUTED;
  ctx.font = `600 15px ${FONT}`;
  ctx.fillText("MODELS VS TYPICAL KOL", ix, top + 26);
  const blockH = (bottom - top - 50) / TIERS.length;
  TIERS.forEach((tier, i) => {
    const by = top + 48 + blockH * i;
    const mr = rateOf(m, tier);
    const kr = kolRate(k, tier).shown;
    const max = Math.max(mr.pct ?? 0, kr ?? 0, 1);
    const e = edge(mr.pct, kolThin ? null : kr);
    ctx.fillStyle = INK;
    ctx.font = `800 17px ${FONT}`;
    ctx.fillText(tier, ix, by + 10);
    if (e && e.side !== "tie") {
      ctx.fillStyle = e.side === "models" ? MODELS : KOLS;
      ctx.font = `700 14px ${FONT}`;
      ctx.textAlign = "right";
      ctx.fillText(
        `${e.side === "models" ? "Models" : "KOLs"} +${e.pts.toFixed(e.pts >= 10 ? 0 : 1)} pts`,
        ix + iw,
        by + 10,
      );
      ctx.textAlign = "left";
    }
    const bar = (rate: number | null, color: string, label: string, y: number) => {
      ctx.fillStyle = INK2;
      ctx.font = `500 14px ${FONT}`;
      ctx.fillText(label, ix, y);
      const bx = ix + 62;
      const bw = iw - 62 - 56;
      ctx.fillStyle = TRACK;
      roundRect(ctx, bx, y - 5, bw, 10, 5);
      ctx.fill();
      ctx.fillStyle = color;
      roundRect(ctx, bx, y - 5, Math.max(rate === null ? 0 : 10, (bw * (rate ?? 0)) / max), 10, 5);
      ctx.fill();
      ctx.fillStyle = INK;
      ctx.font = `750 16px ${FONT}`;
      ctx.textAlign = "right";
      ctx.fillText(rateText(rate), ix + iw, y);
      ctx.textAlign = "left";
    };
    bar(mr.pct, MODELS, "Models", by + 34);
    bar(kr, KOLS, "KOL", by + 56);
  });
}

export async function renderVsKolsCard(d: ModelsVsKols, days: number): Promise<HTMLCanvasElement> {
  const { canvas, ctx, icon } = await cardCanvas();
  if (!ctx) return canvas;
  frame(
    ctx,
    icon,
    "Top models vs the typical KOL",
    "How often their picks hit 2x in 15 min, 4x in 30, 10x in the hour, before a 50% stop.",
    {
      badge: (c, right, cy) => pill(c, right, cy, `Last ${windowName(days)}`),
      footer: "Same grade both sides · KOL = median KOL (10x: average)",
      link: "trenchscanner.app",
      time: true,
    },
  );
  const split = CARD_W - PAD - 330;
  table(ctx, d, days, PAD, split - 36);
  duel(ctx, d, days, split);
  return canvas;
}
