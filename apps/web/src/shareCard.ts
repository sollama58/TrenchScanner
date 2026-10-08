/**
 * What every branded share image has in common: a 1200x675 dark card with the TrenchScanner by
 * ASDFASDFA brand row, a title and subtitle, and a dated footer, as the TokenSage page's cards
 * draw it (tokensage/shareCards.ts keeps its own copy). Drawn on a canvas in the browser, so
 * sharing costs the server nothing and every card comes out the same size whatever the screen.
 */

export const CARD_W = 1200;
export const CARD_H = 675;

export const FONT = '"Inter Variable", "Inter", system-ui, -apple-system, "Segoe UI", sans-serif';
export const MONO = '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, Menlo, monospace';
export const INK = "#ffffff";
export const INK2 = "rgba(255, 255, 255, 0.72)";
export const MUTED = "rgba(255, 255, 255, 0.5)";
export const TRACK = "rgba(255, 255, 255, 0.08)";
/** The dashboard's dark-mode categorical slots (styles.css --series-1..5), and "other". */
export const SERIES = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181"];
export const OTHER = "#4a5163";
export const BRAND_A = "#8b5cf6";
export const BRAND_B = "#3b82f6";

export const PAD = 64;
export const BODY_TOP = 252;
export const BODY_BOTTOM = CARD_H - 112;

let iconPromise: Promise<HTMLImageElement | null> | null = null;
/** The app icon, from the page's own origin so the canvas stays exportable. */
export function loadIcon(): Promise<HTMLImageElement | null> {
  iconPromise ??= new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = "/icon-512.png";
  });
  return iconPromise;
}

export function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
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
export function corners(
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
export function clip(ctx: CanvasRenderingContext2D, text: string, max: number) {
  if (ctx.measureText(text).width <= max) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > max) t = t.slice(0, -1);
  return `${t}…`;
}

/** Background, brand row, title and footer: everything every card shares. */
export function frame(
  ctx: CanvasRenderingContext2D,
  icon: HTMLImageElement | null,
  title: string,
  sub: string,
  opts: {
    /** Draws the badge right-aligned at `right`, centred on `cy`, opposite the brand row. */
    badge: (ctx: CanvasRenderingContext2D, right: number, cy: number) => void;
    /** The footer's left line, before the date. */
    footer: string;
    /** The footer's right side: where the card points. */
    link: string;
  },
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

  // Brand row: icon, "TrenchScanner", "by ASDFASDFA"; the card's badge on the right.
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
  opts.badge(ctx, CARD_W - PAD, 74);

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
  ctx.fillText(`${opts.footer} · ${date}`, PAD, H - 44);
  ctx.textAlign = "right";
  ctx.fillStyle = INK;
  ctx.font = `700 22px ${FONT}`;
  ctx.fillText(opts.link, W - PAD, H - 44);
  ctx.textAlign = "left";
}

/** A gradient pill with a label, right-aligned at `right`; `glyph` draws a 24px icon before it. */
export function pill(
  ctx: CanvasRenderingContext2D,
  right: number,
  cy: number,
  label: string,
  glyph?: (ctx: CanvasRenderingContext2D) => void,
) {
  ctx.font = `700 20px ${FONT}`;
  const tw = ctx.measureText(label).width;
  const w = tw + (glyph ? 74 : 44);
  const x = right - w;
  const g = ctx.createLinearGradient(x, cy - 22, x + w, cy + 22);
  g.addColorStop(0, BRAND_A);
  g.addColorStop(1, BRAND_B);
  ctx.fillStyle = g;
  roundRect(ctx, x, cy - 22, w, 44, 22);
  ctx.fill();
  if (glyph) {
    ctx.save();
    ctx.translate(x + 16, cy - 12);
    ctx.strokeStyle = INK;
    ctx.fillStyle = INK;
    ctx.lineWidth = 2.2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    glyph(ctx);
    ctx.restore();
  }
  ctx.fillStyle = INK;
  ctx.textBaseline = "middle";
  ctx.fillText(label, x + (glyph ? 50 : 22), cy + 1);
}

/** Loads the app icon and waits for the card fonts, then returns a blank card-sized canvas. */
export async function cardCanvas(): Promise<{
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D | null;
  icon: HTMLImageElement | null;
}> {
  const [icon] = await Promise.all([
    loadIcon(),
    // The canvas only draws with a font already loaded; wait for the page's own.
    document.fonts?.load(`800 100px ${FONT}`).catch(() => undefined),
    document.fonts?.load(`500 20px ${MONO}`).catch(() => undefined),
  ]);
  const canvas = document.createElement("canvas");
  canvas.width = CARD_W;
  canvas.height = CARD_H;
  return { canvas, ctx: canvas.getContext("2d"), icon };
}
