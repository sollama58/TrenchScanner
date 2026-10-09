import type { LighthouseTally, MarketLighthouse } from "../api";
import { MIN_GRADED as LIGHTHOUSE_MIN_GRADED, narratives } from "../components/MarketLighthouse";
import { narrativeBaseline, relativeScale } from "../lighthouseMetrics";
import { compact, hitRate, logoKinds, named, prettyLabel } from "./showcase";
import type { ShowcaseCount, TokenSageShowcase } from "./showcase";

/**
 * The /tokensage page's share images: one branded 1200x675 card per section worth posting,
 * drawn on a canvas in the browser like the PnL card (pnlCard.ts), so sharing costs the server
 * nothing and every card comes out the same size and look whatever screen it was made on.
 * Counts only, as on the page.
 */

export type ShareCardKind = "headline" | "themes" | "lineage" | "flags" | "logos" | "fees" | "models";

export const SHARE_CARDS: Record<ShareCardKind, { title: string; file: string }> = {
  headline: { title: "TokenSage at a glance", file: "tokensage" },
  themes: { title: "Top themes", file: "tokensage-themes" },
  lineage: { title: "Originals and copies", file: "tokensage-copies" },
  flags: { title: "Flags raised", file: "tokensage-flags" },
  logos: { title: "What the logo shows", file: "tokensage-logos" },
  fees: { title: "Where the creator fee goes", file: "tokensage-creator-fees" },
  models: { title: "Which narratives pay", file: "tokensage-narratives-pay" },
};

export const CARD_W = 1200;
export const CARD_H = 675;

const FONT = '"Inter Variable", "Inter", system-ui, -apple-system, "Segoe UI", sans-serif';
const MONO = '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, Menlo, monospace';
const INK = "#ffffff";
const INK2 = "rgba(255, 255, 255, 0.72)";
const MUTED = "rgba(255, 255, 255, 0.5)";
const TRACK = "rgba(255, 255, 255, 0.08)";
/** The dashboard's dark-mode categorical slots (styles.css --series-1..5), and "other". */
const SERIES = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181"];
const OTHER = "#4a5163";
const BRAND_A = "#8b5cf6";
const BRAND_B = "#3b82f6";

const PAD = 64;
const BODY_TOP = 252;
const BODY_BOTTOM = CARD_H - 112;

let iconPromise: Promise<HTMLImageElement | null> | null = null;
/** The app icon, from the page's own origin so the canvas stays exportable. */
function loadIcon(): Promise<HTMLImageElement | null> {
  iconPromise ??= new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = "/icon-512.png";
  });
  return iconPromise;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** A rectangle with its own radius on each corner: top-left, top-right, bottom-right, bottom-left. */
function corners(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  [tl, tr, br, bl]: [number, number, number, number],
) {
  const m = Math.min(w / 2, h / 2);
  const [a, b, c, e] = [tl, tr, br, bl].map((r) => Math.min(r, m)) as [number, number, number, number];
  ctx.beginPath();
  ctx.moveTo(x + a, y);
  ctx.lineTo(x + w - b, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + b);
  ctx.lineTo(x + w, y + h - c);
  ctx.quadraticCurveTo(x + w, y + h, x + w - c, y + h);
  ctx.lineTo(x + e, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - e);
  ctx.lineTo(x, y + a);
  ctx.quadraticCurveTo(x, y, x + a, y);
  ctx.closePath();
}

/** Text cut with an ellipsis to fit `max` pixels at the current font. */
function clip(ctx: CanvasRenderingContext2D, text: string, max: number) {
  if (ctx.measureText(text).width <= max) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > max) t = t.slice(0, -1);
  return `${t}…`;
}

/** Background, brand row, title and footer: everything every card shares. */
function frame(
  ctx: CanvasRenderingContext2D,
  icon: HTMLImageElement | null,
  title: string,
  sub: string,
  source: string,
) {
  const W = CARD_W;
  const H = CARD_H;
  ctx.fillStyle = "#0b0b1a";
  ctx.fillRect(0, 0, W, H);
  const glowA = ctx.createRadialGradient(W * 0.1, 0, 0, W * 0.1, 0, W * 0.65);
  glowA.addColorStop(0, "rgba(139, 92, 246, 0.42)");
  glowA.addColorStop(1, "rgba(139, 92, 246, 0)");
  ctx.fillStyle = glowA;
  ctx.fillRect(0, 0, W, H);
  const glowB = ctx.createRadialGradient(W, H, 0, W, H, W * 0.6);
  glowB.addColorStop(0, "rgba(59, 130, 246, 0.36)");
  glowB.addColorStop(1, "rgba(59, 130, 246, 0)");
  ctx.fillStyle = glowB;
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = "rgba(255, 255, 255, 0.04)";
  ctx.lineWidth = 2;
  for (let r = 160; r <= 640; r += 120) {
    ctx.beginPath();
    ctx.arc(W - 120, H + 40, r, Math.PI, Math.PI * 1.5);
    ctx.stroke();
  }

  // Brand row: icon, "TrenchScanner", "by ASDFASDFA"; TokenSage on the right.
  const icon_ = 52;
  if (icon) {
    ctx.save();
    roundRect(ctx, PAD, 48, icon_, icon_, 13);
    ctx.clip();
    ctx.drawImage(icon, PAD, 48, icon_, icon_);
    ctx.restore();
  }
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.fillStyle = INK;
  ctx.font = `700 28px ${FONT}`;
  ctx.fillText("TrenchScanner", PAD + icon_ + 16, 66);
  ctx.fillStyle = MUTED;
  ctx.font = `500 17px ${FONT}`;
  ctx.fillText("by ASDFASDFA", PAD + icon_ + 16, 92);
  sagePill(ctx, CARD_W - PAD, 74);

  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = INK;
  ctx.font = `750 46px ${FONT}`;
  ctx.fillText(clip(ctx, title, W - PAD * 2), PAD, 184);
  ctx.fillStyle = INK2;
  ctx.font = `500 22px ${FONT}`;
  ctx.fillText(clip(ctx, sub, W - PAD * 2), PAD, 222);

  ctx.fillStyle = "rgba(255, 255, 255, 0.12)";
  ctx.fillRect(PAD, H - 82, W - PAD * 2, 1);
  ctx.textBaseline = "middle";
  ctx.fillStyle = MUTED;
  ctx.font = `500 18px ${FONT}`;
  const date = new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  ctx.fillText(`${source} · ${date}`, PAD, H - 44);
  ctx.textAlign = "right";
  ctx.fillStyle = INK;
  ctx.font = `700 22px ${FONT}`;
  ctx.fillText("trenchscanner.app/tokensage", W - PAD, H - 44);
  ctx.textAlign = "left";
}

/** The "TokenSage" pill with its eye, right-aligned at `right`. */
function sagePill(ctx: CanvasRenderingContext2D, right: number, cy: number) {
  ctx.font = `700 20px ${FONT}`;
  const label = "TokenSage";
  const tw = ctx.measureText(label).width;
  const w = tw + 74;
  const x = right - w;
  const g = ctx.createLinearGradient(x, cy - 22, x + w, cy + 22);
  g.addColorStop(0, BRAND_A);
  g.addColorStop(1, BRAND_B);
  ctx.fillStyle = g;
  roundRect(ctx, x, cy - 22, w, 44, 22);
  ctx.fill();
  // The eye (SageIcon), drawn on a 24px grid.
  ctx.save();
  ctx.translate(x + 16, cy - 12);
  ctx.strokeStyle = INK;
  ctx.lineWidth = 2.2;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(2, 12);
  ctx.bezierCurveTo(5.6, 5.5, 18.4, 5.5, 22, 12);
  ctx.bezierCurveTo(18.4, 18.5, 5.6, 18.5, 2, 12);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(12, 12, 2.8, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
  ctx.fillStyle = INK;
  ctx.textBaseline = "middle";
  ctx.fillText(label, x + 50, cy + 1);
}

interface BarRow {
  label: string;
  value: number;
  display: string;
  note?: string;
}

/** Ranked horizontal bars in the body, up to `max` rows; `marker` draws a reference line. */
function bars(
  ctx: CanvasRenderingContext2D,
  rows: BarRow[],
  opts: { top?: number; marker?: number | null } = {},
) {
  const shown = rows.slice(0, 6);
  if (shown.length === 0) return empty(ctx);
  const top = opts.top ?? Math.max(1, ...shown.map((r) => r.value));
  const labelW = 300;
  const valueW = 170;
  const x0 = PAD + labelW;
  const trackW = CARD_W - PAD * 2 - labelW - valueW;
  const rowH = (BODY_BOTTOM - BODY_TOP) / Math.max(5, shown.length);
  shown.forEach((r, i) => {
    const cy = BODY_TOP + rowH * i + rowH / 2;
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.fillStyle = INK2;
    ctx.font = `500 23px ${FONT}`;
    ctx.fillText(clip(ctx, r.label, labelW - 24), PAD, cy);
    ctx.fillStyle = TRACK;
    roundRect(ctx, x0, cy - 11, trackW, 22, 4);
    ctx.fill();
    const w = Math.max(6, (r.value / top) * trackW);
    const g = ctx.createLinearGradient(x0, 0, x0 + trackW, 0);
    g.addColorStop(0, BRAND_A);
    g.addColorStop(1, BRAND_B);
    ctx.fillStyle = g;
    roundRect(ctx, x0, cy - 11, w, 22, 4);
    ctx.fill();
    ctx.textAlign = "right";
    ctx.fillStyle = INK;
    ctx.font = `700 24px ${FONT}`;
    ctx.fillText(r.display, CARD_W - PAD, r.note ? cy - 10 : cy);
    if (r.note) {
      ctx.fillStyle = MUTED;
      ctx.font = `500 15px ${MONO}`;
      ctx.fillText(r.note, CARD_W - PAD, cy + 14);
    }
  });
  if (opts.marker !== null && opts.marker !== undefined) {
    const mx = x0 + (opts.marker / top) * trackW;
    ctx.strokeStyle = "rgba(255, 255, 255, 0.75)";
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 6]);
    ctx.beginPath();
    ctx.moveTo(mx, BODY_TOP - 6);
    ctx.lineTo(mx, BODY_TOP + rowH * shown.length);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.textAlign = "left";
}

/** A 100% bar split by label at `y`, with a legend under it. */
function segments(
  ctx: CanvasRenderingContext2D,
  rows: ShowcaseCount[],
  order: string[],
  y: number,
  height = 44,
) {
  const parts = rows
    .filter((r) => r.count > 0 && r.label !== "other" && r.label !== "unknown")
    .sort((a, b) => {
      const ia = order.indexOf(a.label);
      const ib = order.indexOf(b.label);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || b.count - a.count;
    })
    .slice(0, SERIES.length);
  const rest = rows.reduce((s, r) => s + r.count, 0) - parts.reduce((s, p) => s + p.count, 0);
  const all = [
    ...parts.map((p, i) => ({ ...p, color: SERIES[i]! })),
    ...(rest > 0 ? [{ label: "other", count: rest, color: OTHER }] : []),
  ];
  const total = all.reduce((s, p) => s + p.count, 0);
  if (total === 0) return empty(ctx);
  const width = CARD_W - PAD * 2;
  const gap = 4;
  let x = PAD;
  const usable = width - gap * (all.length - 1);
  all.forEach((p, i) => {
    const w = Math.max(4, (p.count / total) * usable);
    ctx.fillStyle = p.color;
    const first = i === 0;
    const last = i === all.length - 1;
    corners(ctx, x, y, w, height, [first ? 8 : 0, last ? 8 : 0, last ? 8 : 0, first ? 8 : 0]);
    ctx.fill();
    x += w + gap;
  });
  // Legend: swatch, name, share, wrapping onto a second line when needed.
  let lx = PAD;
  let ly = y + height + 44;
  ctx.textBaseline = "middle";
  for (const p of all) {
    const name = p.label === "other" ? "Other" : prettyLabel(p.label);
    const pct = `${Math.round((p.count / total) * 100)}%`;
    ctx.font = `500 22px ${FONT}`;
    const nw = ctx.measureText(name).width;
    ctx.font = `700 22px ${FONT}`;
    const pw = ctx.measureText(pct).width;
    const itemW = 24 + nw + 10 + pw + 36;
    if (lx + itemW > CARD_W - PAD) {
      lx = PAD;
      ly += 40;
    }
    ctx.fillStyle = p.color;
    roundRect(ctx, lx, ly - 8, 16, 16, 4);
    ctx.fill();
    ctx.fillStyle = INK2;
    ctx.font = `500 22px ${FONT}`;
    ctx.fillText(name, lx + 24, ly);
    ctx.fillStyle = INK;
    ctx.font = `700 22px ${FONT}`;
    ctx.fillText(pct, lx + 24 + nw + 10, ly);
    lx += itemW;
  }
  return ly;
}

/** Big stat blocks across the width at `y`. */
function stats(ctx: CanvasRenderingContext2D, items: { value: string; label: string }[], y: number) {
  const w = (CARD_W - PAD * 2) / items.length;
  items.forEach((s, i) => {
    const x = PAD + w * i;
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = INK;
    ctx.font = `750 52px ${FONT}`;
    ctx.fillText(clip(ctx, s.value, w - 24), x, y);
    ctx.fillStyle = INK2;
    ctx.font = `500 20px ${FONT}`;
    ctx.fillText(clip(ctx, s.label, w - 24), x, y + 34);
  });
}

function empty(ctx: CanvasRenderingContext2D) {
  ctx.fillStyle = MUTED;
  ctx.font = `500 24px ${FONT}`;
  ctx.textBaseline = "middle";
  ctx.fillText("Not enough reads yet", PAD, (BODY_TOP + BODY_BOTTOM) / 2);
}

const pctOf = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : "–");

function drawHeadline(ctx: CanvasRenderingContext2D, d: TokenSageShowcase) {
  const t = d.totals;
  const since = d.since
    ? new Date(d.since).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" })
    : null;
  ctx.textBaseline = "alphabetic";
  const g = ctx.createLinearGradient(PAD, 0, PAD + 520, 0);
  g.addColorStop(0, "#b9a6ff");
  g.addColorStop(1, "#7fb2ff");
  ctx.fillStyle = g;
  ctx.font = `800 132px ${FONT}`;
  const big = compact(t.reads);
  ctx.fillText(big, PAD - 4, 382);
  const bw = ctx.measureText(big).width;
  ctx.fillStyle = INK2;
  ctx.font = `500 28px ${FONT}`;
  ctx.fillText(`new coins read${since ? ` since ${since}` : ""}`, PAD + bw + 22, 376);
  stats(
    ctx,
    [
      { value: compact(d.last24h.reads), label: "read in the last 24 hours" },
      { value: compact(t.deep), label: "deep reads" },
      { value: pctOf(t.copiesRecent, t.copiesAnswered), label: "copy a recent coin" },
      { value: pctOf(t.alertsDescribed, t.alerts), label: "of model calls had a read" },
    ],
    BODY_BOTTOM - 28,
  );
}

function drawThemes(ctx: CanvasRenderingContext2D, d: TokenSageShowcase) {
  bars(
    ctx,
    named(d.labels.category).map((l) => ({
      label: prettyLabel(l.label),
      value: l.count,
      display: compact(l.count),
      note: `${pctOf(l.count, d.totals.described)} of coins`,
    })),
  );
}

function drawLineage(ctx: CanvasRenderingContext2D, d: TokenSageShowcase) {
  segments(
    ctx,
    d.anatomy.lineage,
    ["original", "early_copy", "copy", "late_copy", "reference"],
    BODY_TOP + 8,
  );
  const items = d.labels.copy
    .filter((r) => r.label !== "other")
    .map((r) => {
      const rate = hitRate(r);
      return {
        value: rate === null ? compact(r.count) : `${rate.toFixed(0)}%`,
        label:
          rate === null
            ? r.label === "original"
              ? "originals read"
              : "copies read"
            : `of model calls on ${r.label === "original" ? "originals" : "copies"} hit 2x`,
      };
    });
  if (items.length) stats(ctx, items.slice(0, 2), BODY_BOTTOM - 28);
}

function drawFlags(ctx: CanvasRenderingContext2D, d: TokenSageShowcase) {
  bars(
    ctx,
    named(d.labels.flag).map((l) => ({
      label: prettyLabel(l.label),
      value: l.count,
      display: compact(l.count),
      note: `${pctOf(l.count, d.totals.described)} of coins`,
    })),
  );
}

function drawCounts(ctx: CanvasRenderingContext2D, rows: ShowcaseCount[], pick = named<ShowcaseCount>) {
  const shown = pick(rows);
  const total = rows.reduce((sum, r) => sum + r.count, 0);
  bars(
    ctx,
    shown.map((r) => ({
      label: prettyLabel(r.label),
      value: r.count,
      display: compact(r.count),
      note: `${pctOf(r.count, total)} of coins read`,
    })),
  );
}

const avgReturn = (t: LighthouseTally) => (t.returnN > 0 ? t.returnSum / t.returnN : null);
const signed = (v: number | null, suffix = "") =>
  v === null
    ? "–"
    : `${Math.round(v) > 0 ? "+" : Math.round(v) < 0 ? "-" : ""}${Math.abs(Math.round(v))}${suffix}`;
const GAIN = "#16a34a";
const LOSS = "#dc2626";
const UP = "#4ade80";
const DOWN = "#ff8080";

/**
 * The Lighthouse's "Which narratives pay" (HitRates in MarketLighthouse.tsx, relative mode): per
 * narrative, a bar from the all-narrative average by how many points its average return sits
 * above or below it, its own return and 2x rate with that rate's gap, and how many calls it rests
 * on. Thin narratives are faded, as on the page.
 */
function drawModels(ctx: CanvasRenderingContext2D, lh: MarketLighthouse | null) {
  if (!lh) return empty(ctx);
  const all = narratives(lh.outcomes.byCategory);
  const rows = all.slice(0, 6);
  if (rows.length === 0) return empty(ctx);
  const base = narrativeBaseline(lh.outcomes.byCategory);
  const avg = base.avgReturn ?? 0;
  const gapOf = (r: LighthouseTally) => {
    const ret = avgReturn(r);
    return ret === null ? null : ret - avg;
  };
  const scale = relativeScale(all.filter((r) => r.graded >= LIGHTHOUSE_MIN_GRADED).map(gapOf));
  const labelW = 210;
  const trackW = 360;
  const valueW = 76;
  const x0 = PAD + labelW;
  const mid = x0 + trackW / 2;
  const top = BODY_TOP + 34;
  const rowH = (BODY_BOTTOM - top) / Math.max(5, rows.length);

  // Axis: -scale, the average, +scale.
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = MUTED;
  ctx.font = `500 16px ${FONT}`;
  ctx.textAlign = "left";
  ctx.fillText(`-${scale} pts`, x0, BODY_TOP + 14);
  ctx.textAlign = "center";
  ctx.fillText(`avg ${signed(base.avgReturn, "%")}`, mid, BODY_TOP + 14);
  ctx.textAlign = "right";
  ctx.fillText(`+${scale} pts`, x0 + trackW, BODY_TOP + 14);

  rows.forEach((r, i) => {
    const cy = top + rowH * i + rowH / 2;
    const early = r.graded < LIGHTHOUSE_MIN_GRADED;
    const gap = gapOf(r);
    const ret = avgReturn(r);
    const r2x = r.graded > 0 ? (r.won2x / r.graded) * 100 : null;
    // Rounded before it picks a color, so a "(0)" is never drawn red or green.
    const gap2x = r2x !== null && base.rate2x !== null ? Math.round(r2x - base.rate2x) : null;
    ctx.globalAlpha = early ? 0.45 : 1;

    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.fillStyle = SERIES[i] ?? OTHER;
    roundRect(ctx, PAD, cy - 7, 14, 14, 4);
    ctx.fill();
    ctx.fillStyle = INK;
    ctx.font = `500 22px ${FONT}`;
    ctx.fillText(clip(ctx, prettyLabel(r.label), labelW - 40), PAD + 24, cy);

    ctx.fillStyle = TRACK;
    roundRect(ctx, x0, cy - 9, trackW, 18, 9);
    ctx.fill();
    if (gap !== null) {
      const reach = Math.max(3, (Math.min(Math.abs(gap), scale) / scale) * (trackW / 2));
      ctx.fillStyle = gap < 0 ? LOSS : GAIN;
      if (gap < 0) corners(ctx, mid - reach, cy - 9, reach, 18, [9, 0, 0, 9]);
      else corners(ctx, mid, cy - 9, reach, 18, [0, 9, 9, 0]);
      ctx.fill();
    }
    ctx.fillStyle = "rgba(255, 255, 255, 0.7)";
    ctx.fillRect(mid - 1, cy - 15, 2, 30);

    const vx = x0 + trackW + 24 + valueW;
    ctx.textAlign = "right";
    ctx.font = `700 24px ${FONT}`;
    ctx.fillStyle = gap === null || early ? INK2 : gap < 0 ? DOWN : UP;
    ctx.fillText(signed(gap), vx, cy);

    ctx.textAlign = "left";
    ctx.font = `500 19px ${FONT}`;
    let tx = vx + 18;
    const part = (text: string, color: string) => {
      ctx.fillStyle = color;
      ctx.fillText(text, tx, cy);
      tx += ctx.measureText(text).width;
    };
    part(`return ${signed(ret, "%")} · 2x ${r2x === null ? "–" : `${Math.round(r2x)}%`}`, INK2);
    if (gap2x !== null) part(` (${signed(gap2x)})`, early ? INK2 : gap2x < 0 ? DOWN : gap2x > 0 ? UP : INK2);

    ctx.textAlign = "right";
    ctx.fillStyle = MUTED;
    ctx.font = `500 17px ${FONT}`;
    ctx.fillText(
      early ? `${r.graded}/${LIGHTHOUSE_MIN_GRADED} graded` : `${r.graded} graded`,
      CARD_W - PAD,
      cy,
    );
    ctx.globalAlpha = 1;
  });
  ctx.textAlign = "left";
}

const DRAW: Record<
  ShareCardKind,
  (ctx: CanvasRenderingContext2D, d: TokenSageShowcase, lh: MarketLighthouse | null) => void
> = {
  headline: drawHeadline,
  themes: drawThemes,
  lineage: drawLineage,
  flags: drawFlags,
  logos: (ctx, d) => drawCounts(ctx, d.anatomy.logo, logoKinds),
  fees: (ctx, d) => drawCounts(ctx, d.anatomy.fee),
  models: (ctx, _d, lh) => drawModels(ctx, lh),
};

/** The subtitle under each card's title. */
function subtitle(kind: ShareCardKind): string {
  switch (kind) {
    case "headline":
      return "Every new Solana coin, read and understood in seconds.";
    case "themes":
      return "What new Solana coins are about, by the theme TokenSage is surest of.";
    case "lineage":
      return "Where each coin falls in its wave of namesakes.";
    case "flags":
      return "Warnings TokenSage raised on new coins.";
    case "logos":
      return "What the logos of new Solana coins show, read from the picture itself.";
    case "fees":
      return "Where pump.fun's creator fee is set to go on new coins.";
    case "models":
      return "Model calls in the last 7 days by narrative: return and 2x rate against the average.";
  }
}

const TITLES: Record<ShareCardKind, string> = {
  headline: "TokenSage reads the trenches",
  themes: "What the trenches are about",
  lineage: "Most new coins are a copy",
  flags: "What to be wary of",
  logos: "What the logos show",
  fees: "Where the creator fee goes",
  models: "Which narratives pay",
};

export async function renderShareCard(
  kind: ShareCardKind,
  d: TokenSageShowcase,
  lh: MarketLighthouse | null,
): Promise<HTMLCanvasElement> {
  const [icon] = await Promise.all([
    loadIcon(),
    // The canvas only draws with a font already loaded; wait for the page's own.
    document.fonts?.load(`800 100px ${FONT}`).catch(() => undefined),
    document.fonts?.load(`500 20px ${MONO}`).catch(() => undefined),
  ]);
  const canvas = document.createElement("canvas");
  canvas.width = CARD_W;
  canvas.height = CARD_H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  const source =
    kind === "models"
      ? "TrenchScanner model calls, last 7 days"
      : "Counts across every coin TokenSage has read";
  frame(ctx, icon, TITLES[kind], subtitle(kind), source);
  DRAW[kind](ctx, d, lh);
  return canvas;
}
