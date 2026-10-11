import {
  BODY_TOP,
  CARD_W,
  FONT,
  INK,
  INK2,
  MUTED,
  PAD,
  TRACK,
  cardCanvas,
  frame,
  pill,
  roundRect,
} from "../shareCard";

/**
 * The Lighthouse's safety-screen share image: the share of new tokens that cleared the safety
 * screen against the share it turned away as Likely Rugs, on one sliding scale, in the shared
 * branded frame (shareCard.ts).
 */
export interface SafetyCardData {
  accepted: number;
  rejected: number;
  /** "24 hours" or "7 days". */
  span: string;
  /** When the count began, if after the window's start: the card then says "since" that hour (UTC). */
  since?: Date | null;
}

const GOOD = "#34d399";
const BAD = "#f87171";

/**
 * The two shares as shown side by side, adding up to 100: one decimal for both when the smaller
 * one is under 10% (so 3.4% / 96.6%, not 3.4% / 97%), and the accepted side taken from the
 * rounded Likely Rugs figure so the pair never reads 100.4% or 99%.
 */
export function splitPctText(okPct: number, rugPct: number): { ok: string; rug: string } {
  const low = Math.min(okPct, rugPct);
  const dp = low > 0 && low < 10 ? 1 : 0;
  const rug = rugPct.toFixed(dp);
  return { ok: `${(100 - Number(rug)).toFixed(dp)}%`, rug: `${rug}%` };
}

/** "Oct 10, 23:00 UTC": the image is seen by people in any timezone. */
export const sinceUtc = (d: Date) =>
  `${d.toLocaleString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}, ${d.toLocaleString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" })} UTC`;

export async function renderSafetyCard(d: SafetyCardData): Promise<HTMLCanvasElement> {
  const { canvas, ctx, icon } = await cardCanvas();
  if (!ctx) return canvas;
  const total = d.accepted + d.rejected;
  const rugPct = total > 0 ? (d.rejected / total) * 100 : 0;
  const okPct = total > 0 ? 100 - rugPct : 0;
  const text = total > 0 ? splitPctText(okPct, rugPct) : { ok: "–", rug: "–" };
  // While the count is younger than the window, the card says how far back it really goes.
  const since = d.since ? sinceUtc(d.since) : null;
  frame(
    ctx,
    icon,
    "How many new tokens are Likely Rugs?",
    since
      ? `Every token we scanned since ${since}, through our safety screen.`
      : `Every token we scanned in the last ${d.span}, through our safety screen.`,
    {
      badge: (c, right, cy) => pill(c, right, cy, `Last ${d.span}`),
      footer: since
        ? `${total.toLocaleString("en-US")} tokens screened since ${since}`
        : `${total.toLocaleString("en-US")} tokens screened`,
      link: "trenchscanner.app",
    },
  );

  const x0 = PAD;
  const x1 = CARD_W - PAD;
  const w = x1 - x0;

  // The two figures, each over its own end of the scale.
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  ctx.fillStyle = GOOD;
  ctx.font = `800 76px ${FONT}`;
  ctx.fillText(text.ok, x0, BODY_TOP + 96);
  ctx.fillStyle = INK2;
  ctx.font = `600 22px ${FONT}`;
  ctx.fillText(`Accepted · ${d.accepted.toLocaleString("en-US")} tokens`, x0, BODY_TOP + 134);
  ctx.textAlign = "right";
  ctx.fillStyle = BAD;
  ctx.font = `800 76px ${FONT}`;
  ctx.fillText(text.rug, x1, BODY_TOP + 96);
  ctx.fillStyle = INK2;
  ctx.font = `600 22px ${FONT}`;
  ctx.fillText(`Likely Rugs · ${d.rejected.toLocaleString("en-US")} tokens`, x1, BODY_TOP + 134);

  // The scale: accepted fills from the left, Likely Rugs from the right, the knob at the split.
  const ty = BODY_TOP + 176;
  const th = 30;
  ctx.fillStyle = TRACK;
  roundRect(ctx, x0, ty, w, th, th / 2);
  ctx.fill();
  if (total > 0) {
    const split = x0 + (w * okPct) / 100;
    ctx.save();
    roundRect(ctx, x0, ty, w, th, th / 2);
    ctx.clip();
    ctx.fillStyle = GOOD;
    ctx.fillRect(x0, ty, split - x0, th);
    ctx.fillStyle = BAD;
    ctx.fillRect(split, ty, x1 - split, th);
    ctx.restore();
    const kx = Math.min(x1 - 6, Math.max(x0 + 6, split));
    ctx.fillStyle = INK;
    ctx.shadowColor = "rgba(0, 0, 0, 0.45)";
    ctx.shadowBlur = 12;
    roundRect(ctx, kx - 6, ty - 10, 12, th + 20, 6);
    ctx.fill();
    ctx.shadowBlur = 0;
  }

  // Ticks under the scale.
  ctx.fillStyle = MUTED;
  ctx.font = `500 17px ${FONT}`;
  ctx.textBaseline = "top";
  for (const t of [0, 25, 50, 75, 100]) {
    const x = x0 + (w * t) / 100;
    ctx.textAlign = t === 0 ? "left" : t === 100 ? "right" : "center";
    ctx.fillText(`${t}%`, x, ty + th + 16);
  }
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  return canvas;
}
