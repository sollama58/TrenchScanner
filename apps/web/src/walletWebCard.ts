import { shortAddress } from "./format";
import { walletNameText, type WalletNames } from "./walletNames";
import { CARD_H, CARD_W, cardCanvas, clip, FONT, frame, INK, INK2, MUTED, PAD, roundRect } from "./shareCard";
import { TIE_LABEL, WEB_TIES, type PlacedNode, type SideWeb, type WebLayout, type WebTie } from "./walletWeb";

/**
 * The wallet web's share image (user ask 2026-10-16): the headline count of wallets used and its
 * breakdown on the left, the map itself on the right, drawn on the shared 1200x675 card at twice
 * the size so the small bubbles stay sharp. It draws the ties the dialog has switched on.
 */

const SCALE = 2;
/** The dialog's dark-mode tones (styles.css .ww-modal). */
const TONE = {
  hub: "#ffffff",
  known: "#f5b324",
  funded: "#06b6d4",
  funder: "#64748b",
  trades: "#3987e5",
  transfers: "#8b5cf6",
} as const;
type Tone = keyof typeof TONE;
const TIE_TONE: Record<WebTie, Tone> = {
  known: "known",
  funded: "funded",
  trades: "trades",
  transfers: "transfers",
};

function toneOf(n: PlacedNode): Tone {
  if (n.role === "hub" || n.role === "known" || n.role === "funded" || n.role === "funder") return n.role;
  return n.moverOnly ? "transfers" : "trades";
}

/** `#rrggbb` at an alpha. */
function alpha(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}
/** `#rrggbb` mixed toward white. */
function lighten(hex: string, t: number): string {
  const n = parseInt(hex.slice(1), 16);
  const mix = (c: number) => Math.round(c + (255 - c) * t);
  return `rgb(${mix((n >> 16) & 255)}, ${mix((n >> 8) & 255)}, ${mix(n & 255)})`;
}

/** A wallet as the card names it: its name, else its export name, else its short address. */
function nameOf(n: PlacedNode, names: WalletNames, hubName: string): string {
  if (n.role === "hub") return hubName;
  const named = names[n.wallet];
  if (named) return walletNameText(named);
  if (n.role === "funder") return `Funder ${shortAddress(n.wallet)}`;
  return n.name ?? shortAddress(n.wallet);
}

/** The headline's breakdown rows: a dot, a label and a count. */
export function webCardRows(web: SideWeb, layout: WebLayout): { tone: Tone; label: string; value: number }[] {
  if (web.kol)
    return [
      { tone: "known", label: "Known Sides", value: web.counts.known },
      { tone: "funded", label: "KOL Funded Wallets", value: web.counts.funded },
      { tone: "trades", label: "Probable Sides", value: web.counts.possible },
      { tone: "transfers", label: "Moved coins between them", value: web.counts.transfers },
    ];
  return [
    {
      tone: "trades",
      label: "Bought the same coins",
      value: layout.nodes.filter((n) => n.role === "bundle" && !n.moverOnly).length,
    },
    { tone: "transfers", label: "Moved coins between them", value: web.counts.transfers },
    {
      tone: "funder",
      label: "Shared funders",
      value: layout.nodes.filter((n) => n.role === "funder").length,
    },
  ];
}

export async function renderWalletWebCard(
  web: SideWeb,
  layout: WebLayout,
  names: WalletNames,
  hubName: string,
  hidden: ReadonlySet<WebTie> = new Set(),
): Promise<HTMLCanvasElement> {
  const { canvas, ctx, icon } = await cardCanvas(SCALE);
  if (!ctx) return canvas;
  frame(ctx, icon, "", "", {
    badge: () => undefined,
    footer: `Labeled from funding, timing and transfers on chain · ${shortAddress(web.hub)}`,
    link: "trenchscanner.app",
    time: true,
    disclaimer: "Labels are on-chain inferences, not confirmed ownership. Not financial advice.",
  });

  // Left column: who, the headline count, what it is made of, and the ties' key.
  const leftW = 330;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = INK;
  ctx.font = `750 40px ${FONT}`;
  ctx.fillText(clip(ctx, hubName, leftW), PAD, 176);
  ctx.fillStyle = INK2;
  ctx.font = `500 21px ${FONT}`;
  ctx.fillText(web.kol ? "KOL wallet web" : "Multi-Wallet-Bundle web", PAD, 210);

  const big = web.total.toLocaleString("en-US");
  ctx.font = `800 92px ${FONT}`;
  const bigW = ctx.measureText(big).width;
  ctx.fillStyle = "#ff9f66";
  ctx.fillText(big, PAD, 322);
  ctx.fillStyle = INK;
  ctx.font = `700 24px ${FONT}`;
  ctx.fillText(web.total === 1 ? "wallet" : "wallets", PAD + bigW + 16, 286);
  ctx.fillText("used", PAD + bigW + 16, 316);

  let y = 368;
  for (const row of webCardRows(web, layout)) {
    const col = TONE[row.tone];
    ctx.fillStyle = alpha(col, 0.22);
    ctx.beginPath();
    ctx.arc(PAD + 8, y - 6, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.arc(PAD + 8, y - 6, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = row.value > 0 ? INK : MUTED;
    ctx.font = `750 22px ${FONT}`;
    const v = row.value.toLocaleString("en-US");
    ctx.fillText(v, PAD + 28, y);
    const vw = ctx.measureText(v).width;
    ctx.fillStyle = INK2;
    ctx.font = `500 18px ${FONT}`;
    ctx.fillText(clip(ctx, row.label, leftW - 40 - vw), PAD + 38 + vw, y);
    y += 34;
  }

  // The ties' key, as drawn on the map.
  const shown = WEB_TIES.filter((t) => !hidden.has(t) && layout.edges.some((e) => e.type === t));
  y += 10;
  ctx.font = `600 15px ${FONT}`;
  let x = PAD;
  for (const t of shown) {
    const label = TIE_LABEL[t];
    const w = 28 + ctx.measureText(label).width + 18;
    if (x + w > PAD + leftW + 10) {
      x = PAD;
      y += 26;
    }
    tieStroke(ctx, t, 1.6);
    ctx.beginPath();
    ctx.moveTo(x, y - 5);
    ctx.lineTo(x + 20, y - 5);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = INK2;
    ctx.fillText(label, x + 28, y);
    x += w;
  }

  // The map panel: the rest of the card, top to footer.
  const px = PAD + leftW + 36;
  const py = 40;
  const pw = CARD_W - PAD + 20 - px;
  const ph = CARD_H - 100 - py;
  ctx.save();
  roundRect(ctx, px, py, pw, ph, 22);
  ctx.fillStyle = "rgba(255, 255, 255, 0.035)";
  ctx.fill();
  ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.clip();
  ctx.fillStyle = "rgba(255, 255, 255, 0.06)";
  for (let gx = px + 9; gx < px + pw; gx += 18)
    for (let gy = py + 9; gy < py + ph; gy += 18) ctx.fillRect(gx, gy, 1.2, 1.2);
  drawMap(ctx, layout, names, hubName, hidden, { x: px + 12, y: py + 12, w: pw - 24, h: ph - 24 });
  ctx.restore();
  return canvas;
}

/** A tie's stroke style, at a width in map units. */
function tieStroke(ctx: CanvasRenderingContext2D, t: WebTie, width: number) {
  const col = TONE[TIE_TONE[t]];
  ctx.strokeStyle = alpha(col, t === "trades" ? 0.95 : 0.9);
  ctx.lineWidth = t === "trades" ? width * 1.5 : width;
  ctx.lineCap = "round";
  ctx.setLineDash(t === "trades" ? [0.5, 5] : []);
}

function drawMap(
  ctx: CanvasRenderingContext2D,
  layout: WebLayout,
  names: WalletNames,
  hubName: string,
  hidden: ReadonlySet<WebTie>,
  area: { x: number; y: number; w: number; h: number },
) {
  const { box } = layout;
  const k = Math.min(area.w / box.w, area.h / box.h);
  ctx.save();
  ctx.translate(area.x + (area.w - box.w * k) / 2 - box.x * k, area.y + (area.h - box.h * k) / 2 - box.y * k);
  ctx.scale(k, k);

  // Faint rings round the hub, as in the dialog.
  ctx.strokeStyle = "rgba(255, 255, 255, 0.06)";
  ctx.lineWidth = 1 / k;
  ctx.setLineDash([2, 5]);
  for (const r of [96, 150, 210]) {
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  const edges = layout.edges.filter((e) => !hidden.has(e.type));
  for (const e of edges) {
    const path = new Path2D(e.d);
    const col = TONE[TIE_TONE[e.type]];
    if (e.type === "known" || e.type === "transfers") {
      ctx.strokeStyle = alpha(col, 0.18);
      ctx.lineWidth = e.width * 3.2;
      ctx.lineCap = "round";
      ctx.setLineDash([]);
      ctx.stroke(path);
    }
    tieStroke(ctx, e.type, e.width);
    ctx.stroke(path);
    if (e.type === "transfers") {
      // The sparks the dialog animates along each transfer, frozen.
      ctx.strokeStyle = "rgba(237, 233, 254, 0.85)";
      ctx.lineWidth = e.width * 0.9;
      ctx.setLineDash([1.2, 7]);
      ctx.stroke(path);
    }
    ctx.setLineDash([]);
    if (e.type === "funded") {
      ctx.save();
      ctx.translate(e.mid.x, e.mid.y);
      ctx.rotate((e.mid.angle * Math.PI) / 180);
      ctx.fillStyle = col;
      ctx.strokeStyle = "#0b0b1a";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(-4.5, -4);
      ctx.lineTo(5, 0);
      ctx.lineTo(-4.5, 4);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
  }

  const order = [...layout.nodes].sort((a, b) => (a.role === "hub" ? 1 : b.role === "hub" ? -1 : b.r - a.r));
  for (const n of order) drawNode(ctx, n, layout, hubName);
  // Names over every bubble, as in the dialog; the hub's always.
  const all = layout.nodes.length <= 36;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const n of order) {
    if (!all && n.role !== "hub" && n.role !== "known") continue;
    const hub = n.role === "hub";
    ctx.font = hub ? `750 13px ${FONT}` : `600 9.5px ${FONT}`;
    const raw = nameOf(n, names, hubName);
    const text = raw.length > 15 ? `${raw.slice(0, 14)}…` : raw;
    const ty = n.y + n.r + (hub ? 18 : 11);
    ctx.lineWidth = 3;
    ctx.lineJoin = "round";
    ctx.strokeStyle = "rgba(11, 11, 26, 0.9)";
    ctx.strokeText(text, n.x, ty);
    ctx.fillStyle = hub ? INK : INK2;
    ctx.fillText(text, n.x, ty);
  }
  ctx.restore();
}

function drawNode(ctx: CanvasRenderingContext2D, n: PlacedNode, layout: WebLayout, hubName: string) {
  const col = TONE[toneOf(n)];
  const { x, y, r } = n;
  if (n.role === "funder") {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(Math.PI / 4);
    roundRect(ctx, -r, -r, r * 2, r * 2, 2.5);
    ctx.fillStyle = col;
    ctx.fill();
    ctx.strokeStyle = TONE.funded;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([2, 2]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
    return;
  }
  const glow = ctx.createRadialGradient(x, y, r * 0.6, x, y, r * 1.7);
  glow.addColorStop(0, alpha(col, n.role === "hub" ? 0.3 : 0.32));
  glow.addColorStop(1, alpha(col, 0));
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(x, y, r * 1.7, 0, Math.PI * 2);
  ctx.fill();
  if (n.role === "hub") {
    // The brand's dashed ring round the hub.
    ctx.strokeStyle = "#ff8a3d";
    ctx.lineWidth = 2.5;
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    ctx.arc(x, y, r + 6, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  const fill = ctx.createRadialGradient(x - r * 0.3, y - r * 0.4, 0, x - r * 0.3, y - r * 0.4, r * 1.4);
  fill.addColorStop(0, n.role === "hub" ? "#ffffff" : lighten(col, 0.5));
  fill.addColorStop(1, n.role === "hub" ? "#c9cbd6" : col);
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = col;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.save();
  ctx.translate(x - r * 0.32, y - r * 0.42);
  ctx.rotate(-Math.PI / 6);
  ctx.fillStyle = "rgba(255, 255, 255, 0.28)";
  ctx.beginPath();
  ctx.ellipse(0, 0, r * 0.42, r * 0.26, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  if (n.role === "hub") {
    ctx.fillStyle = "#11131a";
    ctx.font = `800 24px ${FONT}`;
    ctx.fillText((hubName.match(/[\p{L}\p{N}]/u)?.[0] ?? "?").toUpperCase(), x, y + 1);
    return;
  }
  const inner = innerText(n, layout);
  if (!inner) return;
  ctx.font = `700 ${Math.max(6.5, Math.min(9.5, r * 0.56))}px ${FONT}`;
  ctx.lineWidth = 1.6;
  ctx.strokeStyle = "rgba(0, 0, 0, 0.25)";
  ctx.strokeText(inner, x, y + 0.5);
  ctx.fillStyle = "#ffffff";
  ctx.fillText(inner, x, y + 0.5);
}

/** What a bubble carries inside it, as the dialog's (innerText in WalletWeb.tsx). */
function innerText(n: PlacedNode, layout: WebLayout): string | null {
  if (n.role === "known") return "own";
  if (n.role === "funded") {
    const sol = layout.edges.find((e) => e.type === "funded" && e.to === n.wallet)?.sol;
    return sol ? `${sol >= 10 ? sol.toFixed(0) : sol.toFixed(1)}◎` : "paid";
  }
  if (n.pct > 0) return `${Math.round(n.pct)}%`;
  return n.transfers ? `${n.transfers}×` : null;
}
