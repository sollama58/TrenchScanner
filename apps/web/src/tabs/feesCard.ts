import {
  BODY_BOTTOM,
  BODY_TOP,
  CARD_W,
  FONT,
  INK,
  INK2,
  MUTED,
  PAD,
  TRACK,
  cardCanvas,
  clip,
  frame,
  pill,
  roundRect,
} from "../shareCard";

/**
 * The Portfolio page's fees-saved share image (user ask 2026-10-19): the wallet's own estimated
 * saving against each other platform, in the shared branded frame (shareCard.ts). Carries the
 * panel's comparison terms (PR #824): the date the rates were checked, "estimated", Terminal
 * marked as an estimate, and no implied tie to the platforms named.
 */
export interface FeesCardData {
  buys: number;
  sells: number;
  volumeSol: number;
  platformFeeSol: number;
  networkFeeSol: number;
  platforms: { name: string; buyBps: number; sellBps: number; savedSol: number; estimate?: boolean }[];
  /** ISO date the rates were checked; absent from older API builds. */
  ratesAsOf?: string;
  solUsd: number | null;
  /** Set when the savings count other platforms' gas and priority fee: theirs per trade, SOL. */
  otherNetwork?: { gasSol: number; priorityFeeSol: number };
}

/** A platform as GET /pro/trade/fees and GET /admin/pro-mode/fees-saved send it. */
export interface FeesPlatform {
  id: string;
  name: string;
  buyBps: number;
  sellBps: number;
  sourceUrl?: string;
  estimate?: boolean;
  feeSol: number;
  savedSol: number;
  /** With other platforms' gas and priority fee on their side; absent from older API builds. */
  feeWithNetworkSol?: number;
  savedWithNetworkSol?: number;
}

const OTHER_NETWORK_KEY = "trenchscanner.fees.otherNetwork";

/** The gas and priority fee toggle (user ask 2026-10-24): on unless the viewer turned it off here. */
export function readOtherNetwork(): boolean {
  try {
    return localStorage.getItem(OTHER_NETWORK_KEY) !== "off";
  } catch {
    return true;
  }
}

export function saveOtherNetwork(on: boolean) {
  try {
    localStorage.setItem(OTHER_NETWORK_KEY, on ? "on" : "off");
  } catch {
    // Private mode: the choice lasts for this visit.
  }
}

/**
 * The platforms with the gas and priority fee toggle applied (user ask 2026-10-24): on, each one's
 * fee and saving carry its 0.001 SOL gas and 0.01 SOL priority fee per trade. An older API that
 * sends no such figures keeps the platform-fee-only ones.
 */
export function withOtherNetwork<P extends FeesPlatform>(platforms: readonly P[], on: boolean): P[] {
  if (!on) return [...platforms];
  return platforms.map((p) => ({
    ...p,
    feeSol: p.feeWithNetworkSol ?? p.feeSol,
    savedSol: p.savedWithNetworkSol ?? p.savedSol,
  }));
}

const UP = "#34d399";
const DOWN = "#f87171";

/** Four decimals below 1 SOL, as the panel shows fees (most would round to 0 at two). */
export function feeText(n: number, signed = false): string {
  const abs = Math.abs(n);
  const text = abs >= 1 ? abs.toFixed(2) : abs.toFixed(4);
  const sign = signed && Number(text) !== 0 ? (n > 0 ? "+" : "-") : !signed && n < 0 ? "-" : "";
  return `${sign}${text} SOL`;
}

const rateText = (p: { buyBps: number; sellBps: number }) =>
  p.buyBps === p.sellBps ? `${p.buyBps / 100}%` : `${p.buyBps / 100}% / ${p.sellBps / 100}%`;

/** "Oct 19, 2026" for the rates' check date, read as a calendar day wherever the image is seen. */
export function asOfText(iso: string | undefined): string | null {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** The footer and disclaimer lines: the comparison terms the panel's footnote states. */
export function feesCardTerms(d: FeesCardData): { footer: string; disclaimer: string } {
  const asOf = asOfText(d.ratesAsOf);
  const estimated = d.platforms.filter((p) => p.estimate).map((p) => p.name);
  const net = d.otherNetwork;
  const footer = [
    "Estimates",
    asOf ? `rates as published ${asOf}` : null,
    net ? `incl. ${net.gasSol} SOL gas + ${net.priorityFeeSol} SOL priority fee per trade elsewhere` : null,
    estimated.length ? `${estimated.join(", ")} rate estimated` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const disclaimer =
    "Standard rates before cashback, referrals or order-size bands. " +
    `Not affiliated with or endorsed by ${d.platforms.map((p) => p.name).join(", ")}.`;
  return { footer, disclaimer };
}

/** The headline: the largest estimated saving, with the platform it is against. */
function hero(ctx: CanvasRenderingContext2D, d: FeesCardData, x0: number, x1: number) {
  const best = d.platforms.reduce((a, b) => (b.savedSol > a.savedSol ? b : a), d.platforms[0]!);
  const top = BODY_TOP + 20;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = MUTED;
  ctx.font = `600 16px ${FONT}`;
  ctx.fillText(clip(ctx, `EST. SAVED VS ${best.name.toUpperCase()}`, x1 - x0), x0, top + 16);
  ctx.fillStyle = best.savedSol > 0 ? UP : best.savedSol < 0 ? DOWN : INK;
  // The biggest size that fits the column.
  const big = feeText(best.savedSol, true);
  let size = 72;
  ctx.font = `800 ${size}px ${FONT}`;
  while (size > 36 && ctx.measureText(big).width > x1 - x0) {
    size -= 4;
    ctx.font = `800 ${size}px ${FONT}`;
  }
  ctx.fillText(big, x0, top + 96);
  if (d.solUsd) {
    ctx.fillStyle = INK2;
    ctx.font = `600 26px ${FONT}`;
    const v = best.savedSol * d.solUsd;
    const abs = Math.abs(v);
    const usd =
      abs >= 1000 ? `$${(abs / 1000).toFixed(1)}K` : abs >= 10 ? `$${abs.toFixed(0)}` : `$${abs.toFixed(2)}`;
    ctx.fillText(`≈ ${v < 0 ? "-" : ""}${usd}`, x0, top + 138);
  }

  // What the saving is on: the trades, the volume, and what was paid here.
  const facts: [string, string][] = [
    ["Trades", `${d.buys} buys / ${d.sells} sales`],
    ["Volume", `${d.volumeSol >= 100 ? d.volumeSol.toFixed(0) : d.volumeSol.toFixed(2)} SOL`],
    ["TrenchScanner fee", d.platformFeeSol === 0 ? "None" : feeText(d.platformFeeSol)],
  ];
  const fy = BODY_BOTTOM - 54;
  const colW = (x1 - x0) / facts.length;
  facts.forEach(([label, value], i) => {
    const fx = x0 + colW * i;
    ctx.fillStyle = MUTED;
    ctx.font = `600 14px ${FONT}`;
    ctx.fillText(clip(ctx, label.toUpperCase(), colW - 12), fx, fy);
    ctx.fillStyle = INK;
    ctx.font = `700 20px ${FONT}`;
    ctx.fillText(clip(ctx, value, colW - 12), fx, fy + 30);
  });
}

/** One row per platform: its rate, a bar for the saving, and the saving. */
function table(ctx: CanvasRenderingContext2D, d: FeesCardData, x0: number) {
  const w = CARD_W - PAD - x0;
  const top = BODY_TOP + 6;
  const bottom = BODY_BOTTOM;
  ctx.fillStyle = "rgba(255, 255, 255, 0.05)";
  roundRect(ctx, x0, top, w, bottom - top, 18);
  ctx.fill();
  const ix = x0 + 24;
  const iw = w - 48;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.fillStyle = MUTED;
  ctx.font = `600 15px ${FONT}`;
  ctx.fillText("EST. SAVED VS", ix, top + 28);
  ctx.textAlign = "right";
  ctx.fillText("THEIR FEE", ix + iw, top + 28);
  const rows = d.platforms;
  const rowH = Math.min(58, (bottom - top - 56) / Math.max(1, rows.length));
  const max = Math.max(1e-12, ...rows.map((p) => Math.abs(p.savedSol)));
  rows.forEach((p, i) => {
    const cy = top + 56 + rowH * i + rowH / 2 - 6;
    ctx.textAlign = "left";
    ctx.fillStyle = INK;
    ctx.font = `650 20px ${FONT}`;
    const name = p.estimate ? `${p.name} (est.)` : p.name;
    ctx.fillText(clip(ctx, name, iw * 0.6), ix, cy - 8);
    ctx.textAlign = "right";
    ctx.fillStyle = INK2;
    ctx.font = `500 16px ${FONT}`;
    ctx.fillText(rateText(p), ix + iw, cy - 8);
    // The bar and the saving under the name.
    const value = feeText(p.savedSol, true);
    ctx.font = `750 18px ${FONT}`;
    const vw = ctx.measureText(value).width;
    const barW = iw - vw - 16;
    const by = cy + 14;
    ctx.fillStyle = TRACK;
    roundRect(ctx, ix, by - 4, barW, 8, 4);
    ctx.fill();
    ctx.fillStyle = p.savedSol >= 0 ? UP : DOWN;
    roundRect(ctx, ix, by - 4, Math.max(6, (Math.abs(p.savedSol) / max) * barW), 8, 4);
    ctx.fill();
    ctx.fillStyle = p.savedSol > 0 ? UP : p.savedSol < 0 ? DOWN : INK;
    ctx.fillText(value, ix + iw, by + 1);
  });
  ctx.textAlign = "left";
}

/** The card's heading: the wallet's own by default, the all-traders total on Admin. */
export interface FeesCardText {
  title: string;
  subtitle: string;
  badge?: string;
}

export const OWN_FEES_TEXT: FeesCardText = {
  title: "What trading here saved me",
  subtitle: "My trades on TrenchScanner, against the fees the same trades would pay elsewhere.",
};

export async function renderFeesCard(
  d: FeesCardData,
  text: FeesCardText = OWN_FEES_TEXT,
): Promise<HTMLCanvasElement> {
  const { canvas, ctx, icon } = await cardCanvas();
  if (!ctx) return canvas;
  const trades = d.buys + d.sells;
  const { footer, disclaimer } = feesCardTerms(d);
  const badge = text.badge ?? `${trades.toLocaleString("en-US")} trade${trades === 1 ? "" : "s"}`;
  frame(ctx, icon, text.title, text.subtitle, {
    badge: (c, right, cy) => pill(c, right, cy, badge),
    footer,
    link: "trenchscanner.app",
    disclaimer,
  });
  const split = CARD_W - PAD - 470;
  hero(ctx, d, PAD, split - 40);
  table(ctx, d, split);
  return canvas;
}
