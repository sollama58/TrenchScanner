import { multiple, signedPct, usd } from "./format";

/** What a PnL share card shows: one of the feed's best alerts and what it returned. */
export interface PnlCardData {
  symbol: string | null;
  name: string | null;
  mintAddress: string;
  /** When it alerted (ISO). */
  at: string;
  /** Its Peak: the highest it went above its alert price, in percent. */
  peakPct: number;
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

/** The cards' backdrop: flat near-black with a flame bar on top and faint radar arcs. */
function drawBackdrop(ctx: CanvasRenderingContext2D, W: number, H: number) {
  ctx.fillStyle = "#0c0d12";
  ctx.fillRect(0, 0, W, H);
  // A thin flame bar along the top edge: the brand, without glows.
  ctx.fillStyle = "#e2581b";
  ctx.fillRect(0, 0, W, 6);
  // Faint radar arcs, echoing the mark.
  ctx.strokeStyle = "rgba(255, 255, 255, 0.05)";
  ctx.lineWidth = 2;
  for (let r = 160; r <= 640; r += 120) {
    ctx.beginPath();
    ctx.arc(W - 120, H + 40, r, Math.PI, Math.PI * 1.5);
    ctx.stroke();
  }
}

/** The brand row, top left: the icon and the wordmark. */
function drawBrand(ctx: CanvasRenderingContext2D, icon: HTMLImageElement | null, pad: number) {
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

  drawBackdrop(ctx, W, H);
  const pad = 64;
  drawBrand(ctx, icon, pad);

  // What alerted it, top right: the model or the reader's own filter.
  if (data.source) {
    const right = W - pad;
    ctx.textAlign = "right";
    ctx.fillStyle = "#ffffff";
    fitText(ctx, data.source.name, 700, 30, W * 0.42);
    ctx.fillText(data.source.name, right, pad + 18);
    ctx.fillStyle = "rgba(255, 255, 255, 0.6)";
    ctx.font = `italic 500 20px ${FONT}`;
    ctx.fillText(data.source.kind === "model" ? "AI KOL" : "Custom Filter", right, pad + 50);
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
  const up = data.peakPct >= 0;
  const x = multiple(data.peakPct);
  ctx.fillStyle = up ? UP : DOWN;
  const xSize = fitText(ctx, x, 800, 200, W * 0.62);
  ctx.fillText(x, pad - 6, 300 + xSize * 0.82);
  const xWidth = ctx.measureText(x).width;
  ctx.fillStyle = up ? UP : DOWN;
  ctx.font = `700 44px ${FONT}`;
  ctx.fillText(signedPct(data.peakPct, 0), pad + xWidth + 24, 300 + xSize * 0.82);
  // The figure is the highest point since the alert, not a return anyone banked: say so.
  ctx.fillStyle = "rgba(255, 255, 255, 0.6)";
  ctx.font = `700 22px ${FONT}`;
  ctx.fillText("PEAK SINCE ALERT", pad + xWidth + 24, 300 + xSize * 0.82 - 58);

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

/**
 * What a position share card shows (user ask 2026-10-18): the trader's own result in one coin.
 * Never the wallet: nothing here can lead back to it. SOL amounts are the trader's choice.
 */
export interface PositionCardData {
  symbol: string | null;
  name: string | null;
  mintAddress: string;
  /** Still holding some, or sold out. */
  open: boolean;
  /** PnL as a share of what went in (0.5 = +50%). */
  pnlPct: number;
  pnlSol: number;
  /** SOL in USD, for the PnL's dollar figure; null leaves it out. */
  solUsd: number | null;
  solIn: number;
  /** What came back plus what's still held, SOL. */
  solBack: number;
  entryMcap: number | null;
  nowMcap: number | null;
  /** Show the SOL and dollar amounts, or only the percentages. */
  showAmounts: boolean;
}

function solFigure(sol: number, signed = false): string {
  const abs = Math.abs(sol);
  const text = `${abs.toFixed(abs >= 100 ? 1 : abs >= 1 ? 2 : 3).replace(/\.?0+$/, "")} SOL`;
  return signed ? `${sol > 0 ? "+" : sol < 0 ? "-" : ""}${text}` : text;
}

/** The position card: the coin, the PnL as big as it goes, and its entry and now. */
export async function renderPositionCard(data: PositionCardData): Promise<HTMLCanvasElement> {
  const [icon] = await Promise.all([
    loadIcon(),
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
  drawBackdrop(ctx, W, H);
  const pad = 64;
  drawBrand(ctx, icon, pad);
  const up = data.pnlPct >= 0;
  const tone = up ? UP : DOWN;

  // Open or closed, top right, as a pill.
  const pill = data.open ? "OPEN POSITION" : "CLOSED POSITION";
  ctx.font = `700 18px ${FONT}`;
  const pillW = ctx.measureText(pill).width + 36;
  roundRect(ctx, W - pad - pillW, pad + 12, pillW, 40, 20);
  ctx.fillStyle = up ? "rgba(52, 211, 153, 0.14)" : "rgba(248, 113, 113, 0.14)";
  ctx.fill();
  ctx.strokeStyle = up ? "rgba(52, 211, 153, 0.5)" : "rgba(248, 113, 113, 0.5)";
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.fillStyle = tone;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(pill, W - pad - pillW / 2, pad + 33);
  ctx.textAlign = "left";

  // The token.
  const ticker = data.symbol ? `$${data.symbol}` : "Unnamed token";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#ffffff";
  fitText(ctx, ticker, 700, 54, W * 0.55);
  ctx.fillText(ticker, pad, 222);
  if (data.name && data.name !== data.symbol) {
    ctx.fillStyle = "rgba(255, 255, 255, 0.6)";
    fitText(ctx, data.name, 500, 24, W * 0.55);
    ctx.fillText(data.name, pad, 260);
  }

  // The PnL, as big as it can be.
  const pct = signedPct(data.pnlPct * 100, Math.abs(data.pnlPct) >= 10 ? 0 : 1);
  ctx.fillStyle = "rgba(255, 255, 255, 0.6)";
  ctx.font = `700 20px ${FONT}`;
  ctx.fillText("PNL", pad, 318);
  ctx.fillStyle = tone;
  const size = fitText(ctx, pct, 800, 168, W * 0.56);
  ctx.fillText(pct, pad - 4, 318 + size * 0.86);
  if (data.showAmounts) {
    const money =
      solFigure(data.pnlSol, true) +
      (data.solUsd ? `  ·  ${data.pnlSol < 0 ? "-" : "+"}${usd(Math.abs(data.pnlSol * data.solUsd))}` : "");
    ctx.fillStyle = tone;
    fitText(ctx, money, 700, 36, W * 0.56, MONO);
    ctx.fillText(money, pad, 318 + size * 0.86 + 58);
  }

  // The figures, a column of tiles on the right.
  const rows: [string, string][] = [
    ["Entry mcap", usd(data.entryMcap)],
    ["Mcap now", usd(data.nowMcap)],
  ];
  if (data.showAmounts)
    rows.push(
      ["Put in", solFigure(data.solIn)],
      [data.open ? "Value + sold" : "Got back", solFigure(data.solBack)],
    );
  else if (data.entryMcap && data.nowMcap)
    rows.push(["Entry to now", multiple((data.nowMcap / data.entryMcap - 1) * 100)]);
  const colX = W * 0.66;
  const colW = W - pad - colX;
  const tileH = 76;
  const gap = 12;
  let y = 150 + Math.max(0, (4 - rows.length) * (tileH + gap)) / 2;
  for (const [label, value] of rows) {
    roundRect(ctx, colX, y, colW, tileH, 14);
    ctx.fillStyle = "rgba(255, 255, 255, 0.06)";
    ctx.fill();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.1)";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.textBaseline = "middle";
    ctx.fillStyle = "rgba(255, 255, 255, 0.6)";
    ctx.font = `600 18px ${FONT}`;
    ctx.fillText(label.toUpperCase(), colX + 20, y + tileH / 2);
    ctx.textAlign = "right";
    ctx.fillStyle = "#ffffff";
    fitText(ctx, value, 700, 28, colW * 0.55, MONO);
    ctx.fillText(value, colX + colW - 20, y + tileH / 2);
    ctx.textAlign = "left";
    y += tileH + gap;
  }

  // Footer: when, the coin's mint (never the wallet), where.
  const when = new Date().toLocaleString(undefined, {
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
  ctx.fillText(`Traded with TrenchScanner alerts · ${when}`, pad, H - 84);
  ctx.fillStyle = "rgba(255, 255, 255, 0.45)";
  ctx.font = `500 18px ${MONO}`;
  ctx.fillText(`${data.mintAddress.slice(0, 6)}…${data.mintAddress.slice(-6)}`, pad, H - 50);
  ctx.textAlign = "right";
  ctx.fillStyle = "#ffffff";
  ctx.font = `700 24px ${FONT}`;
  ctx.fillText("trenchscanner.app", W - pad, H - 66);
  ctx.textAlign = "left";
  return canvas;
}
