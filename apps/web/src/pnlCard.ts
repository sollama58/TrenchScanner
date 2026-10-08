import { multiple, signedPct } from "./format";

/** What a PnL share card shows: one of the feed's best alerts and what it returned. */
export interface PnlCardData {
  symbol: string | null;
  name: string | null;
  mintAddress: string;
  /** When it alerted (ISO). */
  at: string;
  /** Its return under the fixed exit plan, in percent. */
  returnPct: number;
  /** What alerted it: a model the reader follows, or one of their own filters. */
  source: { kind: "filter" | "model"; name: string } | null;
}

export const PNL_CARD_WIDTH = 1200;
export const PNL_CARD_HEIGHT = 675;

const FONT = '"Inter Variable", "Inter", system-ui, -apple-system, "Segoe UI", sans-serif';
const MONO = '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, Menlo, monospace';
const UP = "#34d399";
const DOWN = "#f87171";

let iconPromise: Promise<HTMLImageElement | null> | null = null;

/** The app icon, from the app's own origin so the canvas stays exportable. */
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
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Shrinks the font until the text fits the width. */
function fitText(
  ctx: CanvasRenderingContext2D,
  text: string,
  weight: number,
  size: number,
  maxWidth: number,
  family = FONT,
) {
  let s = size;
  ctx.font = `${weight} ${s}px ${family}`;
  while (s > 12 && ctx.measureText(text).width > maxWidth) {
    s -= 2;
    ctx.font = `${weight} ${s}px ${family}`;
  }
  return s;
}

/**
 * Draws the branded PnL card: the TrenchScanner mark, the token, and its return as a multiple
 * of the stake. Drawn on a canvas in the browser, so sharing one costs the server nothing.
 */
export async function renderPnlCard(data: PnlCardData): Promise<HTMLCanvasElement> {
  const [icon] = await Promise.all([
    loadIcon(),
    // The canvas only draws with a font already loaded; wait for the app's own.
    document.fonts?.load(`800 100px ${FONT}`).catch(() => undefined),
    document.fonts?.load(`500 20px ${MONO}`).catch(() => undefined),
  ]);
  const W = PNL_CARD_WIDTH;
  const H = PNL_CARD_HEIGHT;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;

  // Background: deep night with the brand's violet-to-blue glow.
  ctx.fillStyle = "#0b0b1a";
  ctx.fillRect(0, 0, W, H);
  const glowA = ctx.createRadialGradient(W * 0.15, H * 0.1, 0, W * 0.15, H * 0.1, W * 0.7);
  glowA.addColorStop(0, "rgba(139, 92, 246, 0.55)");
  glowA.addColorStop(1, "rgba(139, 92, 246, 0)");
  ctx.fillStyle = glowA;
  ctx.fillRect(0, 0, W, H);
  const glowB = ctx.createRadialGradient(W * 0.95, H, 0, W * 0.95, H, W * 0.6);
  glowB.addColorStop(0, "rgba(59, 130, 246, 0.5)");
  glowB.addColorStop(1, "rgba(59, 130, 246, 0)");
  ctx.fillStyle = glowB;
  ctx.fillRect(0, 0, W, H);
  // Faint radar arcs, echoing the mark.
  ctx.strokeStyle = "rgba(255, 255, 255, 0.05)";
  ctx.lineWidth = 2;
  for (let r = 160; r <= 640; r += 120) {
    ctx.beginPath();
    ctx.arc(W - 120, H + 40, r, Math.PI, Math.PI * 1.5);
    ctx.stroke();
  }

  const pad = 64;
  // Brand row: the icon, the wordmark.
  const iconSize = 64;
  if (icon) {
    ctx.save();
    roundRect(ctx, pad, pad, iconSize, iconSize, 16);
    ctx.clip();
    ctx.drawImage(icon, pad, pad, iconSize, iconSize);
    ctx.restore();
  }
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#ffffff";
  ctx.font = `700 34px ${FONT}`;
  ctx.fillText("TrenchScanner", pad + iconSize + 18, pad + iconSize / 2);

  // What alerted it, top right: the model or the reader's own filter.
  if (data.source) {
    const right = W - pad;
    ctx.textAlign = "right";
    ctx.fillStyle = "#ffffff";
    fitText(ctx, data.source.name, 700, 30, W * 0.42);
    ctx.fillText(data.source.name, right, pad + 18);
    ctx.fillStyle = "rgba(255, 255, 255, 0.6)";
    ctx.font = `italic 500 20px ${FONT}`;
    ctx.fillText(data.source.kind === "model" ? "Machine Model" : "Custom Filter", right, pad + 50);
    ctx.textAlign = "left";
  }

  // The token.
  const ticker = data.symbol ? `$${data.symbol}` : "Unnamed token";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#ffffff";
  fitText(ctx, ticker, 700, 56, W - pad * 2);
  ctx.fillText(ticker, pad, 238);
  if (data.name && data.name !== data.symbol) {
    ctx.fillStyle = "rgba(255, 255, 255, 0.6)";
    fitText(ctx, data.name, 500, 26, W - pad * 2);
    ctx.fillText(data.name, pad, 280);
  }

  // The multiple, as big as it can be.
  const up = data.returnPct >= 0;
  const x = multiple(data.returnPct);
  ctx.fillStyle = up ? UP : DOWN;
  const xSize = fitText(ctx, x, 800, 200, W * 0.62);
  ctx.shadowColor = up ? "rgba(52, 211, 153, 0.45)" : "rgba(248, 113, 113, 0.4)";
  ctx.shadowBlur = 40;
  ctx.fillText(x, pad - 6, 300 + xSize * 0.82);
  ctx.shadowBlur = 0;
  const xWidth = ctx.measureText(x).width;
  ctx.fillStyle = up ? UP : DOWN;
  ctx.font = `700 44px ${FONT}`;
  ctx.fillText(signedPct(data.returnPct, 0), pad + xWidth + 24, 300 + xSize * 0.82);

  // Footer: when, the mint, where.
  const when = new Date(data.at).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  ctx.fillStyle = "rgba(255, 255, 255, 0.12)";
  ctx.fillRect(pad, H - 120, W - pad * 2, 1);
  ctx.textBaseline = "middle";
  ctx.fillStyle = "rgba(255, 255, 255, 0.75)";
  ctx.font = `500 22px ${FONT}`;
  ctx.fillText(`Alerted ${when}`, pad, H - 84);
  ctx.fillStyle = "rgba(255, 255, 255, 0.45)";
  ctx.font = `500 18px ${MONO}`;
  const mint = `${data.mintAddress.slice(0, 6)}…${data.mintAddress.slice(-6)}`;
  ctx.fillText(mint, pad, H - 50);
  ctx.textAlign = "right";
  ctx.fillStyle = "#ffffff";
  ctx.font = `700 24px ${FONT}`;
  ctx.fillText("trenchscanner.app", W - pad, H - 66);
  ctx.textAlign = "left";
  return canvas;
}

export function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), "image/png"));
}
