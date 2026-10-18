import type { LighthouseCount, LighthouseTally, MarketLighthouse, MarketWeather } from "../api";
import { pct, signedPct } from "../format";
import { MIN_GRADED_FOR_RATE as MIN_GRADED } from "../rates";
import type { Series, Unit } from "../lighthouseMetrics";
import {
  BODY_BOTTOM,
  BODY_TOP,
  BRAND_A,
  CARD_W,
  FONT,
  INK,
  INK2,
  MUTED,
  OTHER,
  PAD,
  SERIES,
  TRACK,
  cardCanvas,
  clip,
  corners,
  frame,
  pill,
  roundRect,
} from "../shareCard";
import { drawNarrativesPay } from "../tokensage/shareCards";
import { drawPricingChange, pricingChangeSlot } from "../pricingChange";
import { prettyLabel } from "../tokensage/showcase";

/**
 * The Lighthouse tab's share images: one per section, in the shared branded frame (shareCard.ts)
 * with the section's window on the badge and the time it was drawn in the footer, so a posted
 * image always says which day or week it read. Aggregates only, as on the page.
 */

const LINK = "trenchscanner.app";
const UP = "#34d399";
const DOWN = "#f87171";
/** The weather dial's three bands, as on the page (the cold and hot series slots). */
const COLD = SERIES[0]!;
const HOT = SERIES[1]!;
const NORMAL = "rgba(255, 255, 255, 0.34)";

const label = prettyLabel;
const share = (part: number, whole: number) => (whole > 0 ? (part / whole) * 100 : null);
const sum = (rows: LighthouseCount[]) => rows.reduce((s, r) => s + r.count, 0);
const n = (v: number) => v.toLocaleString("en-US");
const tone = (v: number | null) => (v === null || Math.round(v) === 0 ? INK : v > 0 ? UP : DOWN);

/** "Last 24 hours" / "Last 7 days" on the badge. */
const windowBadge = (text: string) => (ctx: CanvasRenderingContext2D, right: number, cy: number) =>
  pill(ctx, right, cy, text);

function empty(ctx: CanvasRenderingContext2D, text: string) {
  ctx.fillStyle = MUTED;
  ctx.font = `500 24px ${FONT}`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.fillText(text, PAD, (BODY_TOP + BODY_BOTTOM) / 2);
}

/** Words wrapped to `max` pixels at the current font, at most `lines` lines (the last clipped). */
function wrap(ctx: CanvasRenderingContext2D, text: string, max: number, lines: number): string[] {
  const out: string[] = [];
  let line = "";
  const all = text.split(/\s+/);
  for (let i = 0; i < all.length; i++) {
    const next = line ? `${line} ${all[i]}` : all[i]!;
    if (ctx.measureText(next).width <= max || !line) {
      line = next;
      continue;
    }
    out.push(line);
    line = all[i]!;
    if (out.length === lines - 1) {
      line = all.slice(i).join(" ");
      break;
    }
  }
  if (line) out.push(clip(ctx, line, max));
  return out.slice(0, lines);
}

/** Stat blocks across `x0..x1` with their value baseline at `y`; a swatch color goes before the label. */
function stats(
  ctx: CanvasRenderingContext2D,
  items: { value: string; label: string; color?: string; swatch?: string }[],
  y: number,
  x0 = PAD,
  x1 = CARD_W - PAD,
  size = 52,
) {
  const w = (x1 - x0) / items.length;
  items.forEach((s, i) => {
    const x = x0 + w * i;
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left";
    ctx.fillStyle = s.color ?? INK;
    ctx.font = `750 ${size}px ${FONT}`;
    ctx.fillText(clip(ctx, s.value, w - 24), x, y);
    let lx = x;
    if (s.swatch) {
      ctx.fillStyle = s.swatch;
      roundRect(ctx, x, y + 21, 14, 14, 4);
      ctx.fill();
      lx += 22;
    }
    ctx.fillStyle = INK2;
    ctx.font = `500 20px ${FONT}`;
    ctx.fillText(clip(ctx, s.label, w - 24 - (lx - x)), lx, y + 34);
  });
}

/** Ranked horizontal bars down the body, up to six rows. */
function bars(
  ctx: CanvasRenderingContext2D,
  rows: { label: string; value: number; display: string; note?: string }[],
) {
  const shown = rows.slice(0, 6);
  const top = Math.max(1, ...shown.map((r) => r.value));
  const labelW = 330;
  const valueW = 170;
  const x0 = PAD + labelW;
  const trackW = CARD_W - PAD * 2 - labelW - valueW;
  const rowH = (BODY_BOTTOM - BODY_TOP) / Math.max(5, shown.length);
  shown.forEach((r, i) => {
    const cy = BODY_TOP + rowH * i + rowH / 2;
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.fillStyle = MUTED;
    ctx.font = `700 18px ${FONT}`;
    ctx.fillText(String(i + 1), PAD, cy);
    ctx.fillStyle = INK;
    ctx.font = `500 23px ${FONT}`;
    ctx.fillText(clip(ctx, r.label, labelW - 56), PAD + 30, cy);
    ctx.fillStyle = TRACK;
    roundRect(ctx, x0, cy - 11, trackW, 22, 6);
    ctx.fill();
    ctx.fillStyle = BRAND_A;
    roundRect(ctx, x0, cy - 11, Math.max(8, (r.value / top) * trackW), 22, 6);
    ctx.fill();
    ctx.textAlign = "right";
    ctx.fillStyle = INK;
    ctx.font = `700 24px ${FONT}`;
    ctx.fillText(r.display, CARD_W - PAD, r.note ? cy - 10 : cy);
    if (r.note) {
      ctx.fillStyle = MUTED;
      ctx.font = `500 16px ${FONT}`;
      ctx.fillText(r.note, CARD_W - PAD, cy + 14);
    }
  });
  ctx.textAlign = "left";
}

/** One 100% bar of a signal's answers at (x, y), titled above, with its biggest three named under it. */
function split(
  ctx: CanvasRenderingContext2D,
  title: string,
  rows: LighthouseCount[],
  emptyText: string,
  x: number,
  y: number,
  w: number,
) {
  const total = sum(rows);
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  ctx.fillStyle = INK;
  ctx.font = `650 22px ${FONT}`;
  ctx.fillText(title, x, y);
  if (total > 0) {
    ctx.textAlign = "right";
    ctx.fillStyle = MUTED;
    ctx.font = `500 16px ${FONT}`;
    ctx.fillText(`${n(total)} read`, x + w, y);
    ctx.textAlign = "left";
  }
  const by = y + 14;
  const bh = 22;
  if (total === 0) {
    ctx.fillStyle = TRACK;
    roundRect(ctx, x, by, w, bh, 6);
    ctx.fill();
    ctx.fillStyle = MUTED;
    ctx.font = `500 16px ${FONT}`;
    ctx.textBaseline = "middle";
    ctx.fillText(emptyText, x + 12, by + bh / 2 + 1);
    return;
  }
  const parts = rows.filter((r) => r.count > 0);
  const gap = 3;
  const usable = w - gap * (parts.length - 1);
  let cx = x;
  parts.forEach((r, i) => {
    const pw = Math.max(3, (r.count / total) * usable);
    ctx.fillStyle = SERIES[i] ?? OTHER;
    const first = i === 0;
    const last = i === parts.length - 1;
    corners(ctx, cx, by, pw, bh, [first ? 6 : 0, last ? 6 : 0, last ? 6 : 0, first ? 6 : 0]);
    ctx.fill();
    cx += pw + gap;
  });
  let lx = x;
  const ly = by + bh + 24;
  ctx.textBaseline = "middle";
  for (const [i, r] of parts.slice(0, 3).entries()) {
    const name = label(r.label);
    const p = pct(share(r.count, total));
    ctx.font = `500 17px ${FONT}`;
    const nw = ctx.measureText(name).width;
    ctx.font = `700 17px ${FONT}`;
    const pw = ctx.measureText(p).width;
    const item = 20 + nw + 7 + pw + 22;
    if (lx + item - 22 > x + w) break;
    ctx.fillStyle = SERIES[i] ?? OTHER;
    roundRect(ctx, lx, ly - 6, 12, 12, 3);
    ctx.fill();
    ctx.fillStyle = INK2;
    ctx.font = `500 17px ${FONT}`;
    ctx.fillText(name, lx + 20, ly);
    ctx.fillStyle = INK;
    ctx.font = `700 17px ${FONT}`;
    ctx.fillText(p, lx + 20 + nw + 7, ly);
    lx += item;
  }
}

// ---------- Market weather ----------

const CONDITION: Record<MarketWeather["condition"], string> = {
  hot: "Hot market",
  normal: "Normal market",
  cold: "Cold market",
  unknown: "Too early to read",
};

/** The page's dial (WeatherGauge.tsx): half the week's rate at the far left, one and a half at the right. */
function dial(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, ratio: number | null) {
  const at = (t: number) => Math.PI * (1 + t);
  const cold = (0.75 - 0.5) / 1;
  const hot = (1.25 - 0.5) / 1;
  const gap = 0.012;
  ctx.lineCap = "round";
  ctx.lineWidth = 26;
  for (const [from, to, color] of [
    [0.01, cold - gap, COLD],
    [cold + gap, hot - gap, NORMAL],
    [hot + gap, 0.99, HOT],
  ] as const) {
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.arc(cx, cy, r, at(from), at(to));
    ctx.stroke();
  }
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `600 19px ${FONT}`;
  ctx.fillStyle = COLD;
  ctx.fillText("Cold", cx - r, cy + 40);
  ctx.fillStyle = HOT;
  ctx.fillText("Hot", cx + r, cy + 40);
  ctx.fillStyle = INK2;
  ctx.fillText("Normal", cx, cy - r - 34);
  if (ratio !== null) {
    const t = Math.min(1, Math.max(0, ratio - 0.5));
    const a = at(t);
    const len = r - 30;
    ctx.strokeStyle = INK;
    ctx.lineWidth = 7;
    ctx.shadowColor = "rgba(0, 0, 0, 0.45)";
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + len * Math.cos(a), cy + len * Math.sin(a));
    ctx.stroke();
    ctx.shadowBlur = 0;
  }
  ctx.fillStyle = INK;
  ctx.beginPath();
  ctx.arc(cx, cy, 13, 0, Math.PI * 2);
  ctx.fill();
  ctx.textAlign = "left";
}

export async function renderWeatherCard(w: MarketWeather): Promise<HTMLCanvasElement> {
  const { canvas, ctx, icon } = await cardCanvas();
  if (!ctx) return canvas;
  frame(
    ctx,
    icon,
    "Market weather",
    "How often new launches double within 15 minutes, against the last week.",
    {
      badge: windowBadge(`Last ${w.recentHours} hours`),
      footer: `${n(w.recentGraded)} launch moments graded`,
      link: LINK,
      time: true,
    },
  );
  const ratio = w.condition === "unknown" ? null : (w.ratio ?? (w.condition === "hot" ? 1.5 : 1));
  dial(ctx, PAD + 190, BODY_BOTTOM - 30, 170, ratio);

  const x = PAD + 470;
  const right = CARD_W - PAD;
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = w.condition === "hot" ? HOT : w.condition === "cold" ? COLD : INK;
  ctx.font = `800 64px ${FONT}`;
  ctx.fillText(CONDITION[w.condition], x, BODY_TOP + 70);
  const vs =
    w.recentRatePct !== null && w.trailingRatePct !== null && w.trailingRatePct > 0
      ? (w.recentRatePct / w.trailingRatePct - 1) * 100
      : null;
  stats(
    ctx,
    [
      { value: pct(w.recentRatePct, 1), label: `doubled, last ${w.recentHours}h` },
      { value: pct(w.trailingRatePct, 1), label: `${w.trailingDays}-day average` },
      { value: vs === null ? "–" : signedPct(vs), label: "against the week", color: tone(vs) },
    ],
    BODY_TOP + 170,
    x,
    right,
    46,
  );
  ctx.fillStyle = MUTED;
  ctx.font = `500 18px ${FONT}`;
  wrap(ctx, "25% or more above the week reads hot, 25% or more below reads cold.", right - x, 2).forEach(
    (line, i) => ctx.fillText(line, x, BODY_TOP + 262 + i * 26),
  );
  return canvas;
}

// ---------- How screened tokens did ----------

type Screened = MarketLighthouse["screened"];
const TIERS = [
  { key: "hit2xPct", short: "2x", label: "hit 2x within 15 min" },
  { key: "hit4xPct", short: "4x", label: "hit 4x within 30 min" },
  { key: "hit10xPct", short: "10x", label: "hit 10x within 1 hr" },
] as const;

function bucketTick(iso: string, hours: number) {
  const t = new Date(iso);
  if (hours >= 24)
    return t.toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", day: "numeric" });
  return `${t.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" })}`;
}

export async function renderScreenedCard(s: Screened, span: string): Promise<HTMLCanvasElement> {
  const { canvas, ctx, icon } = await cardCanvas();
  if (!ctx) return canvas;
  frame(
    ctx,
    icon,
    "How screened tokens did",
    "Every token that passed our safety pre-checks, graded from when it looked ready.",
    {
      badge: windowBadge(`Last ${span}`),
      footer: `${n(s.graded)} tokens graded on a fixed exit plan, rules 3-4`,
      link: LINK,
      time: true,
    },
  );
  const statsY = BODY_TOP + 44;
  stats(
    ctx,
    [
      ...TIERS.map((t, i) => ({ value: pct(s[t.key], 1), label: t.label, swatch: SERIES[i] })),
      { value: signedPct(s.avgReturnPct, 1), label: "average return", color: tone(s.avgReturnPct) },
    ],
    statsY,
  );

  const buckets = s.byBucket.filter((b) => b.graded > 0);
  const top = statsY + 76;
  const base = BODY_BOTTOM - 4;
  if (buckets.length === 0) return canvas;
  const max = Math.max(
    10,
    Math.ceil(Math.max(...buckets.flatMap((b) => TIERS.map((t) => b[t.key] ?? 0))) / 10) * 10,
  );
  const left = PAD + 52;
  const right = CARD_W - PAD;
  const h = base - top - 24;
  const y = (v: number) => base - 24 - (v / max) * h;
  ctx.textBaseline = "middle";
  ctx.textAlign = "right";
  ctx.font = `500 15px ${FONT}`;
  for (const t of [0, max / 2, max]) {
    ctx.strokeStyle = t === 0 ? "rgba(255, 255, 255, 0.2)" : "rgba(255, 255, 255, 0.07)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(left, y(t));
    ctx.lineTo(right, y(t));
    ctx.stroke();
    ctx.fillStyle = MUTED;
    ctx.fillText(`${t}%`, left - 10, y(t));
  }
  const slot = (right - left) / buckets.length;
  const bw = Math.max(2, Math.min(16, (slot * 0.78) / 3));
  const starts = buckets.map((b) => Date.parse(b.at));
  const change = pricingChangeSlot(starts, s.bucketHours * 3_600_000);
  if (change !== null) drawPricingChange(ctx, left + slot * change, top, y(0), FONT, right);
  const every = Math.ceil(buckets.length / 8);
  buckets.forEach((b, i) => {
    const gx = left + slot * i + (slot - bw * 3 - 4) / 2;
    TIERS.forEach((t, j) => {
      const v = b[t.key] ?? 0;
      const bh = Math.max(1.5, (v / max) * h);
      ctx.fillStyle = SERIES[j]!;
      corners(ctx, gx + j * (bw + 2), y(0) - bh, bw, bh, [3, 3, 0, 0]);
      ctx.fill();
    });
    if (i % every === 0) {
      ctx.fillStyle = MUTED;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.font = `500 14px ${FONT}`;
      ctx.fillText(bucketTick(b.at, s.bucketHours), left + slot * i + slot / 2, base - 16);
    }
  });
  ctx.textAlign = "left";
  return canvas;
}

// ---------- What TokenSage sees ----------

export async function renderTokenSageCard(d: MarketLighthouse, span: string): Promise<HTMLCanvasElement> {
  const { canvas, ctx, icon } = await cardCanvas();
  if (!ctx) return canvas;
  frame(ctx, icon, "What TokenSage sees", "Every new Solana coin the scanner reads, understood in seconds.", {
    badge: windowBadge(`Last ${span}`),
    footer: d.tokenSage.on ? "TokenSage reads, live" : "TokenSage reads stored before it paused",
    link: LINK,
    time: true,
  });
  ctx.textBaseline = "alphabetic";
  const g = ctx.createLinearGradient(PAD, 0, PAD + 520, 0);
  g.addColorStop(0, "#b9a6ff");
  g.addColorStop(1, "#7fb2ff");
  ctx.fillStyle = g;
  ctx.font = `800 128px ${FONT}`;
  const big = n(d.reads.described);
  ctx.fillText(big, PAD - 4, BODY_TOP + 118);
  const bw = ctx.measureText(big).width;
  ctx.fillStyle = INK2;
  ctx.font = `500 28px ${FONT}`;
  ctx.fillText(`new coins read in the last ${span}`, PAD + bw + 22, BODY_TOP + 110);
  const copies = share(d.copies.find((c) => c.label === "copies a recent coin")?.count ?? 0, sum(d.copies));
  stats(
    ctx,
    [
      { value: n(d.reads.deep), label: "deep reads" },
      {
        value: d.avgReferentConfidence === null ? "–" : pct(d.avgReferentConfidence * 100),
        label: "story confidence",
      },
      { value: pct(copies), label: "copy a recent coin" },
      { value: pct(share(d.outcomes.described, d.outcomes.alerts)), label: "model alerts with a read" },
    ],
    BODY_BOTTOM - 28,
  );
  return canvas;
}

// ---------- Narrative mix ----------

export async function renderNarrativeMixCard(d: MarketLighthouse, span: string): Promise<HTMLCanvasElement> {
  const { canvas, ctx, icon } = await cardCanvas();
  if (!ctx) return canvas;
  frame(
    ctx,
    icon,
    "Narrative mix",
    "What new Solana coins are about, by share of the coins TokenSage read.",
    {
      badge: windowBadge(`Last ${span}`),
      footer: `${n(d.reads.described)} coins read by TokenSage`,
      link: LINK,
      time: true,
    },
  );
  // The tide's order sets the colors, as on the page: its biggest five, then "other".
  const order = d.tide.series.map((s) => s.label).filter((l) => l !== "other");
  const parts = d.tide.series
    .map((s) => ({ label: s.label, n: s.values.reduce((a, b) => a + b, 0) }))
    .filter((p) => p.n > 0)
    .sort((a, b) => (a.label === "other" ? 1 : b.label === "other" ? -1 : b.n - a.n));
  const total = parts.reduce((s, p) => s + p.n, 0);
  if (total === 0) {
    empty(ctx, "No coins described in this window.");
    return canvas;
  }
  const color = (l: string) => {
    const i = order.indexOf(l);
    return l === "other" || i < 0 ? OTHER : (SERIES[i] ?? OTHER);
  };
  const cx = PAD + 150;
  const cy = (BODY_TOP + BODY_BOTTOM) / 2 + 6;
  const r = 128;
  const ring = 44;
  ctx.lineWidth = ring;
  ctx.strokeStyle = TRACK;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
  const gap = parts.length > 1 ? 0.025 : 0;
  let a = -Math.PI / 2;
  for (const p of parts) {
    const len = (p.n / total) * Math.PI * 2;
    ctx.strokeStyle = color(p.label);
    ctx.beginPath();
    ctx.arc(cx, cy, r, a + gap / 2, a + Math.max(gap / 2 + 0.005, len - gap / 2));
    ctx.stroke();
    a += len;
  }
  const lead = parts[0]!;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = INK;
  ctx.font = `800 46px ${FONT}`;
  ctx.fillText(pct(share(lead.n, total)), cx, cy + 10);
  ctx.fillStyle = INK2;
  ctx.font = `500 18px ${FONT}`;
  ctx.fillText(clip(ctx, label(lead.label), r * 1.3), cx, cy + 38);

  // The legend, one row per narrative, with its share as a bar.
  const x0 = PAD + 360;
  const x1 = CARD_W - PAD;
  const rows = parts.slice(0, 6);
  const rowH = (BODY_BOTTOM - BODY_TOP) / Math.max(5, rows.length);
  const barX = x0 + 300;
  const barW = x1 - barX - 90;
  const most = Math.max(...rows.map((p) => p.n));
  rows.forEach((p, i) => {
    const y = BODY_TOP + rowH * i + rowH / 2;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillStyle = color(p.label);
    roundRect(ctx, x0, y - 8, 16, 16, 4);
    ctx.fill();
    ctx.fillStyle = INK;
    ctx.font = `500 23px ${FONT}`;
    ctx.fillText(clip(ctx, label(p.label), barX - x0 - 48), x0 + 28, y);
    ctx.fillStyle = TRACK;
    roundRect(ctx, barX, y - 8, barW, 16, 8);
    ctx.fill();
    ctx.fillStyle = color(p.label);
    roundRect(ctx, barX, y - 8, Math.max(8, (p.n / most) * barW), 16, 8);
    ctx.fill();
    ctx.textAlign = "right";
    ctx.fillStyle = INK;
    ctx.font = `700 24px ${FONT}`;
    ctx.fillText(pct(share(p.n, total)), x1, y);
  });
  ctx.textAlign = "left";
  return canvas;
}

// ---------- Hottest sub-narratives ----------

export async function renderSubNarrativesCard(d: MarketLighthouse, span: string): Promise<HTMLCanvasElement> {
  const { canvas, ctx, icon } = await cardCanvas();
  if (!ctx) return canvas;
  frame(ctx, icon, "Hottest sub-narratives", "The labels TokenSage put on the most new coins.", {
    badge: windowBadge(`Last ${span}`),
    footer: `${n(d.reads.described)} coins read by TokenSage`,
    link: LINK,
    time: true,
  });
  if (d.categories.length === 0) {
    empty(ctx, "No sub-narratives in this window.");
    return canvas;
  }
  bars(
    ctx,
    d.categories.map((c) => ({
      label: label(c.label),
      value: c.count,
      display: n(c.count),
      note: `${pct(share(c.count, d.reads.described))} of coins`,
    })),
  );
  return canvas;
}

// ---------- Which narratives pay ----------

export async function renderNarrativesPayCard(
  outcomes: { byCategory: LighthouseTally[]; graded: number },
  span: string,
): Promise<HTMLCanvasElement> {
  const { canvas, ctx, icon } = await cardCanvas();
  if (!ctx) return canvas;
  frame(
    ctx,
    icon,
    "Which narratives pay",
    `Model alerts by narrative: return and 2x rate against the average alert.`,
    {
      badge: windowBadge(`Last ${span}`),
      footer: `${n(outcomes.graded)} graded model alerts · 2x in 15 min before a 50% stop, rules 3-4`,
      link: LINK,
      time: true,
    },
  );
  drawNarrativesPay(ctx, { outcomes });
  return canvas;
}

// ---------- Fee recipients ----------

export interface FeeRecipientsCardData {
  /** Coins read by who gets their creator fee, biggest first. */
  feeRecipients: LighthouseCount[];
  /** Model calls by the same groups. */
  byFeeRecipient: LighthouseTally[];
}

/**
 * Who gets the creator fee on new coins, as one 100% bar, then a row per group: its share of the
 * coins read and how model calls on its coins did (2x rate and average return under the exit plan).
 */
export async function renderFeeRecipientsCard(
  d: FeeRecipientsCardData,
  span: string,
): Promise<HTMLCanvasElement> {
  const { canvas, ctx, icon } = await cardCanvas();
  if (!ctx) return canvas;
  const total = sum(d.feeRecipients);
  const graded = d.byFeeRecipient.reduce((s, r) => s + r.graded, 0);
  frame(ctx, icon, "Fee recipients", "Who gets the creator fee on new coins, and how alerts on them did.", {
    badge: windowBadge(`Last ${span}`),
    footer: `${n(total)} coins with a known fee recipient · ${n(graded)} graded model alerts`,
    link: LINK,
    time: true,
  });
  if (total === 0) {
    empty(ctx, "No fee recipients read in this window.");
    return canvas;
  }
  split(ctx, "Coins read", d.feeRecipients, "", PAD, BODY_TOP + 20, CARD_W - PAD * 2);

  const calls = new Map(d.byFeeRecipient.map((t) => [t.label, t]));
  const cols = [PAD + 330, PAD + 560, PAD + 800, CARD_W - PAD];
  const top = BODY_TOP + 128;
  const rowH = Math.min(44, (BODY_BOTTOM - top - 26) / d.feeRecipients.length);
  ctx.textBaseline = "middle";
  ctx.fillStyle = MUTED;
  ctx.font = `600 16px ${FONT}`;
  ctx.textAlign = "right";
  ["Of coins", "Alerts 2x", "Avg return", "Graded"].forEach((h, i) => ctx.fillText(h, cols[i]!, top));
  d.feeRecipients.forEach((r, i) => {
    const cy = top + 26 + rowH * i + rowH / 2;
    const t = calls.get(r.label);
    const r2x = t && t.graded > 0 ? (t.won2x / t.graded) * 100 : null;
    const ret = t && t.returnN > 0 ? t.returnSum / t.returnN : null;
    ctx.globalAlpha = t && t.graded >= MIN_GRADED ? 1 : 0.55;
    ctx.textAlign = "left";
    ctx.fillStyle = SERIES[i] ?? OTHER;
    roundRect(ctx, PAD, cy - 7, 14, 14, 4);
    ctx.fill();
    ctx.fillStyle = INK;
    ctx.font = `500 23px ${FONT}`;
    ctx.fillText(label(r.label), PAD + 26, cy);
    ctx.textAlign = "right";
    ctx.font = `700 23px ${FONT}`;
    ctx.fillText(pct(share(r.count, total)), cols[0]!, cy);
    ctx.fillText(r2x === null ? "–" : pct(r2x), cols[1]!, cy);
    ctx.fillStyle = tone(ret);
    ctx.fillText(ret === null ? "–" : signedPct(ret), cols[2]!, cy);
    ctx.fillStyle = INK2;
    ctx.font = `500 21px ${FONT}`;
    ctx.fillText(t ? n(t.graded) : "0", cols[3]!, cy);
  });
  ctx.globalAlpha = 1;
  ctx.textAlign = "left";
  return canvas;
}

// ---------- Signals at a glance ----------

export interface SignalsCardData {
  xVerdicts: LighthouseCount[];
  news: LighthouseCount[];
  copies: LighthouseCount[];
  pairKinds: LighthouseCount[];
  deep: number;
  described: number;
}

export async function renderSignalsCard(s: SignalsCardData, span: string): Promise<HTMLCanvasElement> {
  const { canvas, ctx, icon } = await cardCanvas();
  if (!ctx) return canvas;
  frame(
    ctx,
    icon,
    "Signals at a glance",
    "What TokenSage found behind new coins: each bar is 100% of the coins it read.",
    {
      badge: windowBadge(`Last ${span}`),
      footer: `${n(s.described)} coins read by TokenSage`,
      link: LINK,
      time: true,
    },
  );
  const quick = s.deep === 0;
  const colW = (CARD_W - PAD * 2 - 56) / 2;
  const cells: [string, LighthouseCount[], string][] = [
    ["X link check", s.xVerdicts, quick ? "Waits on deep reads" : "No linked posts read"],
    ["In the news", s.news, quick ? "Waits on deep reads" : "Not read yet"],
    ["Original or copy", s.copies, "Not said yet"],
    ["Trades against", s.pairKinds, "Not said yet"],
  ];
  cells.forEach(([title, rows, emptyText], i) => {
    const x = PAD + (i % 2) * (colW + 56);
    const y = BODY_TOP + 24 + Math.floor(i / 2) * 150;
    split(ctx, title, rows, emptyText, x, y, colW);
  });
  return canvas;
}

// ---------- A Lighthouse tab chart ----------

export interface TrendCardData {
  title: string;
  /** e.g. "Last 30 days · per day". */
  badge: string;
  labels: { short: string; full: string }[];
  series: Series[];
  kind: "line" | "bars" | "stacked";
  /** Where pricing changed, in bucket widths from the left edge (pricingChangeSlot). */
  pricingChange?: number | null;
}

const fmt = (v: number, unit: Unit) =>
  unit === "count"
    ? n(Math.round(v))
    : unit === "ret"
      ? signedPct(v)
      : pct(v, Math.abs(v) < 10 && v !== 0 ? 1 : 0);

/** Round bounds and a step of 1, 2, 2.5 or 5 times a power of ten. */
function nice(lo: number, hi: number) {
  if (hi <= lo) hi = lo + 1;
  const raw = (hi - lo) / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const m = raw / mag;
  const step = (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * mag;
  return { min: Math.floor(lo / step) * step, max: Math.ceil(hi / step) * step, step };
}

/**
 * One of the reader's charts (TrendChart.tsx) as an image: the same series, scales and colors,
 * with the legend across the top of the body. A second unit gets the right-hand axis.
 */
export async function renderTrendCard(d: TrendCardData): Promise<HTMLCanvasElement> {
  const { canvas, ctx, icon } = await cardCanvas();
  if (!ctx) return canvas;
  frame(ctx, icon, d.title, "From the TrenchScanner Lighthouse, kept hour by hour.", {
    badge: windowBadge(d.badge),
    footer: "TrenchScanner Lighthouse history",
    link: LINK,
    time: true,
  });
  const color = (slot: number) => (slot === 0 ? OTHER : (SERIES[slot - 1] ?? OTHER));
  // Legend.
  let lx = PAD;
  const ly = BODY_TOP + 2;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  const rightUnit = d.series.find((s) => s.unit !== d.series[0]?.unit)?.unit;
  for (const s of d.series) {
    const name = rightUnit && s.unit === rightUnit ? `${s.label} (right)` : s.label;
    ctx.font = `500 18px ${FONT}`;
    const w = 22 + ctx.measureText(name).width + 26;
    if (lx + w > CARD_W - PAD) break;
    ctx.fillStyle = color(s.slot);
    roundRect(ctx, lx, ly - 6, 14, 12, 3);
    ctx.fill();
    ctx.fillStyle = INK2;
    ctx.fillText(name, lx + 22, ly);
    lx += w;
  }
  const n_ = d.labels.length;
  if (n_ === 0 || d.series.length === 0) {
    empty(ctx, "Nothing to draw in this window yet.");
    return canvas;
  }
  const units: Unit[] = [];
  for (const s of d.series) if (!units.includes(s.unit)) units.push(s.unit);
  const top = BODY_TOP + 34;
  const base = BODY_BOTTOM - 22;
  const left = PAD + 64;
  const right = CARD_W - PAD - (units[1] ? 64 : 0);
  const h = base - top;
  const scale = (unit: Unit) => {
    let lo = 0;
    let hi = 0;
    for (const s of d.series) {
      if (s.unit !== unit) continue;
      if (s.target !== undefined) hi = Math.max(hi, s.target);
    }
    if (d.kind === "stacked") {
      for (let i = 0; i < n_; i++) {
        let tot = 0;
        for (const s of d.series) if (s.unit === unit) tot += Math.max(0, s.values[i] ?? 0);
        hi = Math.max(hi, tot);
      }
    } else {
      for (const s of d.series)
        if (s.unit === unit)
          for (const v of s.values)
            if (v !== null) {
              hi = Math.max(hi, v);
              lo = Math.min(lo, v);
            }
    }
    if (unit === "pct") lo = 0;
    return nice(lo, hi);
  };
  const scales = new Map(units.map((u) => [u, scale(u)]));
  const yOf = (unit: Unit, v: number) => {
    const sc = scales.get(unit)!;
    return base - ((Math.min(sc.max, Math.max(sc.min, v)) - sc.min) / (sc.max - sc.min)) * h;
  };
  // Grid and axes.
  ctx.font = `500 15px ${FONT}`;
  ctx.textBaseline = "middle";
  units.slice(0, 2).forEach((u, ui) => {
    const sc = scales.get(u)!;
    for (let t = sc.min; t <= sc.max + 1e-9; t += sc.step) {
      const y = yOf(u, t);
      if (ui === 0) {
        ctx.strokeStyle = Math.abs(t) < 1e-9 ? "rgba(255, 255, 255, 0.22)" : "rgba(255, 255, 255, 0.07)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(left, y);
        ctx.lineTo(right, y);
        ctx.stroke();
      }
      ctx.fillStyle = MUTED;
      ctx.textAlign = ui === 0 ? "right" : "left";
      ctx.fillText(fmt(t, u), ui === 0 ? left - 10 : right + 10, y);
    }
  });
  const slotW = (right - left) / n_;
  const xOf = (i: number) => left + slotW * i + slotW / 2;
  // Ticks: up to eight.
  const every = Math.ceil(n_ / 8);
  ctx.textBaseline = "top";
  ctx.textAlign = "center";
  ctx.fillStyle = MUTED;
  ctx.font = `500 14px ${FONT}`;
  for (let i = 0; i < n_; i += every) ctx.fillText(d.labels[i]!.short, xOf(i), base + 8);
  if (d.pricingChange != null) drawPricingChange(ctx, left + slotW * d.pricingChange, top, base, FONT, right);

  if (d.kind === "line") {
    for (const s of d.series) {
      if (s.target !== undefined) {
        ctx.strokeStyle = color(s.slot);
        ctx.globalAlpha = 0.6;
        ctx.lineWidth = 2;
        ctx.setLineDash([8, 7]);
        ctx.beginPath();
        ctx.moveTo(left, yOf(s.unit, s.target));
        ctx.lineTo(right, yOf(s.unit, s.target));
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
      }
      ctx.strokeStyle = color(s.slot);
      ctx.lineWidth = 3.5;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.beginPath();
      let pen = false;
      s.values.forEach((v, i) => {
        if (v === null) {
          pen = false;
          return;
        }
        if (pen) ctx.lineTo(xOf(i), yOf(s.unit, v));
        else ctx.moveTo(xOf(i), yOf(s.unit, v));
        pen = true;
      });
      ctx.stroke();
      if (n_ <= 40) {
        ctx.fillStyle = color(s.slot);
        s.values.forEach((v, i) => {
          if (v === null) return;
          ctx.beginPath();
          ctx.arc(xOf(i), yOf(s.unit, v), 4, 0, Math.PI * 2);
          ctx.fill();
        });
      }
    }
  } else if (d.kind === "stacked") {
    const bw = Math.max(2, slotW * 0.7);
    for (let i = 0; i < n_; i++) {
      let acc = 0;
      for (const s of d.series) {
        const v = Math.max(0, s.values[i] ?? 0);
        if (v <= 0) continue;
        const y0 = yOf(s.unit, acc);
        const y1 = yOf(s.unit, acc + v);
        ctx.fillStyle = color(s.slot);
        ctx.fillRect(xOf(i) - bw / 2, y1, bw, Math.max(1, y0 - y1 - 1));
        acc += v;
      }
    }
  } else {
    const k = d.series.length;
    const bw = Math.max(2, (slotW * 0.78) / k);
    for (let i = 0; i < n_; i++) {
      d.series.forEach((s, j) => {
        const v = s.values[i];
        if (v === null || v === undefined) return;
        const y0 = yOf(s.unit, 0);
        const y1 = yOf(s.unit, v);
        const x = xOf(i) - (bw * k) / 2 + j * bw;
        ctx.fillStyle = color(s.slot);
        const top_ = Math.min(y0, y1);
        const hh = Math.max(1.5, Math.abs(y0 - y1));
        corners(ctx, x + 0.5, top_, Math.max(1, bw - 1), hh, v >= 0 ? [3, 3, 0, 0] : [0, 0, 3, 3]);
        ctx.fill();
      });
    }
  }
  ctx.textAlign = "left";
  return canvas;
}
