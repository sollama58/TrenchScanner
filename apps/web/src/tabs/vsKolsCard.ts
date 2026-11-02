import type { ModelsVsKols, VsRow } from "../api";
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
import { TIERS, edge, leaderOf, rateOf, rateText, sideTotal, tiersAt, windowName } from "./vsKolsView";

/**
 * The share image of the Models tab's "Models vs KOLs": the top three models and the top KOLs, a
 * row each, with their 2x, 4x and 10x rates over one window, and each side's calls together on the
 * right, in the shared branded frame (shareCard.ts). KOL pictures are left out: they come from the
 * API's origin, and drawing them would taint the canvas so it could not be exported.
 */

const MODELS = SERIES[0]!;
const KOLS = SERIES[1]!;
const LEAD = "#34d399";

function mark(ctx: CanvasRenderingContext2D, row: VsRow, index: number, cx: number, cy: number) {
  const color = row.kind === "model" ? MODELS : KOLS;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(cx, cy, 15, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = INK;
  ctx.font = `800 15px ${FONT}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const glyph = row.kind === "model" ? String(index + 1) : (row.name.trim()[0] ?? "?").toUpperCase();
  ctx.fillText(glyph, cx, cy + 1);
  ctx.textAlign = "left";
}

function table(ctx: CanvasRenderingContext2D, d: ModelsVsKols, days: number, x0: number, x1: number) {
  const rows = [...d.models, ...d.kols];
  const nameW = 300;
  const colW = (x1 - x0 - nameW) / TIERS.length;
  const top = BODY_TOP + 14;
  const headH = 30;
  const gap = d.models.length && d.kols.length ? 14 : 0;
  const rowH = Math.min(46, (BODY_BOTTOM - top - headH - gap) / Math.max(1, rows.length));

  ctx.textBaseline = "middle";
  ctx.font = `700 15px ${FONT}`;
  ctx.fillStyle = MUTED;
  ctx.fillText(`LAST ${windowName(days).toUpperCase()}`, x0, top + headH / 2);
  TIERS.forEach((t, i) => {
    ctx.textAlign = "right";
    ctx.fillText(t.toUpperCase(), x0 + nameW + colW * (i + 1) - 8, top + headH / 2);
  });
  ctx.textAlign = "left";

  const leaders = new Map(TIERS.map((t) => [t, leaderOf(rows, days, t, MIN_GRADED_FOR_RATE)]));
  let y = top + headH;
  rows.forEach((row, i) => {
    if (i === d.models.length && i > 0) {
      ctx.fillStyle = "rgba(255, 255, 255, 0.1)";
      ctx.fillRect(x0, y + gap / 2, x1 - x0, 1);
      y += gap;
    }
    const cy = y + rowH / 2;
    const index = row.kind === "model" ? i : i - d.models.length;
    mark(ctx, row, index, x0 + 15, cy);
    const t = tiersAt(row, days);
    ctx.fillStyle = INK;
    ctx.font = `650 18px ${FONT}`;
    ctx.fillText(clip(ctx, row.name, nameW - 60), x0 + 42, cy - 9);
    ctx.fillStyle = MUTED;
    ctx.font = `500 13px ${FONT}`;
    ctx.fillText(
      `${(t?.graded ?? 0).toLocaleString("en-US")} graded ${row.kind === "model" ? "calls" : "picks"}`,
      x0 + 42,
      cy + 11,
    );
    TIERS.forEach((tier, c) => {
      const r = rateOf(t, tier);
      const right = x0 + nameW + colW * (c + 1) - 8;
      const lead = leaders.get(tier) === row.id;
      const thin = r.n < MIN_GRADED_FOR_RATE;
      const text = rateText(r.pct);
      ctx.font = `800 24px ${FONT}`;
      const tw = ctx.measureText(text).width;
      if (lead) {
        ctx.fillStyle = "rgba(52, 211, 153, 0.16)";
        roundRect(ctx, right - tw - 14, cy - 17, tw + 22, 34, 10);
        ctx.fill();
      }
      ctx.fillStyle = lead ? LEAD : thin ? MUTED : INK;
      ctx.textAlign = "right";
      ctx.fillText(text, right - 3, cy + 1);
      ctx.textAlign = "left";
    });
    y += rowH;
  });
}

/** Each side's calls together: one bar pair per tier. */
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
  const k = sideTotal(d.kols, days);
  ctx.textBaseline = "middle";
  ctx.fillStyle = MUTED;
  ctx.font = `600 15px ${FONT}`;
  ctx.fillText("EACH SIDE TOGETHER", ix, top + 26);
  const blockH = (bottom - top - 50) / TIERS.length;
  TIERS.forEach((tier, i) => {
    const by = top + 48 + blockH * i;
    const mr = rateOf(m, tier);
    const kr = rateOf(k, tier);
    const max = Math.max(mr.pct ?? 0, kr.pct ?? 0, 1);
    const e = edge(mr, kr);
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
    bar(kr.pct, KOLS, "KOLs", by + 56);
  });
}

export async function renderVsKolsCard(d: ModelsVsKols, days: number): Promise<HTMLCanvasElement> {
  const { canvas, ctx, icon } = await cardCanvas();
  if (!ctx) return canvas;
  frame(
    ctx,
    icon,
    "Top models vs top KOLs",
    "How often their picks hit 2x in 15 min, 4x in 30, 10x in the hour, before a 50% stop.",
    {
      badge: (c, right, cy) => pill(c, right, cy, `Last ${windowName(days)}`),
      footer: "One grade both sides · KOL pick: bought before our clock started",
      link: "trenchscanner.app",
      time: true,
    },
  );
  const split = CARD_W - PAD - 330;
  table(ctx, d, days, PAD, split - 36);
  duel(ctx, d, days, split);
  return canvas;
}
