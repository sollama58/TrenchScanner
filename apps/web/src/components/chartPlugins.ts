import type {
  CustomData,
  CustomSeriesOptions,
  CustomSeriesPricePlotValues,
  CustomSeriesWhitespaceData,
  ICustomSeriesPaneRenderer,
  ICustomSeriesPaneView,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesPrimitive,
  PaneRendererCustomData,
  PriceToCoordinateConverter,
  SeriesAttachedParameter,
  Time,
} from "lightweight-charts";
import { customSeriesDefaultOptions } from "lightweight-charts";
import type { DrawColors, Drawings, DrawScale } from "../chartDrawings";
import type { PathStep } from "../pricePathing";
import { layoutMarks, type MarkSpot, type PlacedMark } from "../chartMarkLayout";
import { markRadius, type WalletMark } from "../walletMarks";

/** The canvas target the library hands its renderers (fancy-canvas's CanvasRenderingTarget2D). */
type Target = Parameters<ICustomSeriesPaneRenderer["draw"]>[0];

/** One slot of the candle series (chartBars.ts SlotBar), keyed by its time in seconds. */
export interface SlotCandleData extends CustomData<Time> {
  o: number;
  h: number;
  l: number;
  c: number;
  flat?: boolean;
  span?: number;
  under?: number;
}

export interface SlotCandleOptions extends CustomSeriesOptions {
  upColor: string;
  downColor: string;
  flatColor: string;
}

/**
 * The candle series: the library's own draws every candle one slot wide, so a candle coarser than
 * the timeframe (a minute candle where the 1-second ones don't reach) would squeeze into one slot
 * and leave a gap after it. This one draws it across the slots it covers, at its real width.
 */
export class SlotCandleSeries implements ICustomSeriesPaneView<Time, SlotCandleData, SlotCandleOptions> {
  private data: PaneRendererCustomData<Time, SlotCandleData> | null = null;
  private options: SlotCandleOptions | null = null;

  renderer(): ICustomSeriesPaneRenderer {
    return { draw: (target, toY) => this.draw(target, toY) };
  }

  update(data: PaneRendererCustomData<Time, SlotCandleData>, options: SlotCandleOptions): void {
    this.data = data;
    this.options = options;
  }

  priceValueBuilder(d: SlotCandleData): CustomSeriesPricePlotValues {
    return [d.l, d.h, d.c];
  }

  isWhitespace(d: SlotCandleData | CustomSeriesWhitespaceData<Time>): d is CustomSeriesWhitespaceData<Time> {
    return (d as Partial<SlotCandleData>).c === undefined;
  }

  defaultOptions(): SlotCandleOptions {
    return { ...customSeriesDefaultOptions, upColor: "#4ade80", downColor: "#ff8080", flatColor: "#8c94a7" };
  }

  private draw(target: Target, toY: PriceToCoordinateConverter): void {
    const data = this.data;
    const opt = this.options;
    if (!data?.visibleRange || !opt) return;
    const { bars, barSpacing, visibleRange } = data;
    target.useBitmapCoordinateSpace(({ context: ctx, horizontalPixelRatio: hr, verticalPixelRatio: vr }) => {
      let lastDrawn = -1;
      const wickW = Math.max(1, Math.floor(hr));
      for (let i = visibleRange.from; i < visibleRange.to; i++) {
        const own = bars[i];
        if (!own) continue;
        // A slot under a wider candle draws that candle (once), even when it starts off screen.
        const pi = own.originalData.under ? i - own.originalData.under : i;
        if (pi <= lastDrawn) continue;
        lastDrawn = pi;
        const p = bars[pi] ?? own;
        const d = p.originalData;
        const span = d.span ?? 1;
        const x0 = p.x - barSpacing / 2;
        const total = barSpacing * span;
        const gap = barSpacing >= 3 ? Math.max(1, barSpacing * 0.2) : 0;
        const bodyW = Math.max(1 / hr, total - gap);
        const cx = x0 + total / 2;
        const yo = toY(d.o);
        const yc = toY(d.c);
        const yh = toY(d.h);
        const yl = toY(d.l);
        if (yo === null || yc === null || yh === null || yl === null) continue;
        ctx.fillStyle = d.flat ? opt.flatColor : d.c >= d.o ? opt.upColor : opt.downColor;
        const wx = Math.round(cx * hr) - Math.floor(wickW / 2);
        ctx.fillRect(wx, Math.round(yh * vr), wickW, Math.max(1, Math.round((yl - yh) * vr)));
        const bx = Math.round((cx - bodyW / 2) * hr);
        const bw = Math.max(1, Math.round(bodyW * hr));
        const top = Math.round(Math.min(yo, yc) * vr);
        ctx.fillRect(bx, top, bw, Math.max(1, Math.round(Math.abs(yc - yo) * vr)));
      }
    });
  }
}

/** A moment marked across the chart: an alert, a model's call, the screen pass, graduation. */
export interface OverlayEvent {
  t: number;
  label: string;
  lead: boolean;
}

/** One of the Pro trader's own trades. */
export interface OverlayTrade {
  t: number;
  side: "buy" | "sell";
}

/** What a placed mark on the chart is: a labeled wallet's trade, or the trader's own. */
export type MarkItem = { mark: WalletMark; trade?: undefined } | { trade: OverlayTrade; mark?: undefined };

/** A KOL's picture mark's radius (px), growing with the trade's size like the rings. */
export function picRadius(sol: number): number {
  return markRadius(sol) + 3;
}
/** A level's height in the marks' stacks: the largest picture's diameter. */
const MARK_PITCH = 2 * picRadius(1e9);

export interface OverlayColors {
  event: string;
  eventLead: string;
  eventText: string;
  labelBg: string;
  buy: string;
  sell: string;
  page: string;
  surface: string;
  path: string;
  pathBand: string;
  font: string;
  /** A wallet mark's colour and its text's, by kind (walletMarks.ts MarkKind). */
  wk: (kind: string) => { fill: string; ink: string };
  draw: DrawColors;
}

/** What the overlay draws, set by the chart on each render. */
export interface OverlayState {
  /** A time (ms) and a market cap to CSS px on the plot; null off it. */
  x: (t: number) => number | null;
  y: (v: number) => number | null;
  /** The market cap the line or candles show at a time (ms). */
  valueAt: (t: number) => number | null;
  /** The low and high there (the candle's; the price itself on the line), which marks hang from. */
  rangeAt: (t: number) => { lo: number; hi: number } | null;
  events: OverlayEvent[];
  /** How far down the plot the events' flags start (px), clear of the readout. */
  flagTop: number;
  marks: WalletMark[];
  trades: OverlayTrade[];
  /** The predicted path, from the latest reading, drawn in the zone past the last candle. */
  path: PathStep[];
  pathZone: { x0: number; w: number } | null;
  /** The wallet marks under the pointer, drawn stronger. */
  hot: ReadonlySet<WalletMark>;
  /** A KOL's picture, once loaded (null: none, not yet, or it failed: the lettered ring shows). */
  pic: (mark: WalletMark) => CanvasImageSource | null;
  /** How big the trade marks draw (Customize › Chart wallet trades). */
  markScale: number;
  drawings: Drawings | null;
  drawScale: DrawScale | null;
  label: (v: number) => string;
  colors: OverlayColors | null;
}

/**
 * Everything the chart marks over its candles, as one series primitive: the alert and model lines
 * with their flags along the top, labeled wallets' trades as lettered rings (filled for a buy,
 * sized by SOL) or KOLs' pictures, the trader's own B and S arrows, the predicted path, and the
 * drawings.
 */
export class ChartOverlay implements ISeriesPrimitive<Time> {
  state: OverlayState;
  /** Where the marks were last drawn (CSS px), for the chart's hover and click. */
  placed: PlacedMark<MarkItem>[] = [];
  private requestUpdate: (() => void) | null = null;
  private readonly views: readonly IPrimitivePaneView[];

  constructor(state: OverlayState) {
    this.state = state;
    const renderer: IPrimitivePaneRenderer = {
      draw: (target) =>
        target.useBitmapCoordinateSpace((s) =>
          this.draw(s.context, s.horizontalPixelRatio, s.verticalPixelRatio, s.mediaSize.width),
        ),
    };
    this.views = [{ renderer: () => renderer, zOrder: () => "top" }];
  }

  attached(p: SeriesAttachedParameter<Time>): void {
    this.requestUpdate = p.requestUpdate;
  }
  detached(): void {
    this.requestUpdate = null;
  }
  paneViews(): readonly IPrimitivePaneView[] {
    return this.views;
  }
  update(): void {
    this.requestUpdate?.();
  }

  private draw(ctx: CanvasRenderingContext2D, hr: number, vr: number, width: number): void {
    const s = this.state;
    const c = s.colors;
    if (!c) return;
    const height = ctx.canvas.height / vr;
    ctx.save();
    ctx.textBaseline = "middle";

    // The alert and model lines, dashed top to bottom, each flagged along the top; flags that
    // would touch move down a row.
    const rows: number[] = [];
    ctx.font = `600 ${Math.round(10.5 * vr)}px ${c.font}`;
    const events = s.events
      .map((e) => ({ e, x: s.x(e.t) }))
      .filter((e): e is { e: OverlayEvent; x: number } => e.x !== null && e.x >= 0 && e.x <= width)
      .sort((a, b) => a.x - b.x);
    for (const { e, x } of events) {
      ctx.strokeStyle = e.lead ? c.eventLead : c.event;
      ctx.lineWidth = (e.lead ? 1.5 : 1) * hr;
      ctx.setLineDash([4 * hr, 4 * hr]);
      ctx.beginPath();
      ctx.moveTo(Math.round(x * hr) + 0.5, 0);
      ctx.lineTo(Math.round(x * hr) + 0.5, height * vr);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    for (const { e, x } of events) {
      const w = ctx.measureText(e.label).width / hr + 12;
      const left = Math.min(width - w - 2, Math.max(2, x - w / 2));
      let row = rows.findIndex((end) => end + 4 <= left);
      if (row < 0) row = rows.length < 3 ? rows.length : rows.indexOf(Math.min(...rows));
      rows[row] = left + w;
      const y = s.flagTop + row * 19;
      ctx.fillStyle = e.lead ? c.eventLead : c.labelBg;
      roundRect(ctx, left * hr, y * vr, w * hr, 16 * vr, 8 * hr);
      ctx.fill();
      if (!e.lead) {
        ctx.strokeStyle = c.event;
        ctx.lineWidth = hr;
        ctx.stroke();
      }
      ctx.fillStyle = e.lead ? c.page : c.eventText;
      ctx.fillText(e.label, (left + 6) * hr, (y + 8.5) * vr);
    }

    // The predicted path: its band, the dotted guess and the zone's edge.
    if (s.pathZone && s.path.length > 1) {
      const p0 = s.path[0]!;
      const steps = s.path.slice(1).filter((p) => p.t > p0.t);
      const end = steps[steps.length - 1];
      const y0 = s.y(p0.v);
      if (end && y0 !== null) {
        const { x0, w } = s.pathZone;
        const fx = (t: number) => (x0 + ((t - p0.t) / Math.max(1, end.t - p0.t)) * w) * hr;
        const fy = (v: number) => (s.y(v) ?? y0) * vr;
        ctx.strokeStyle = c.event;
        ctx.lineWidth = hr;
        ctx.setLineDash([3 * hr, 3 * hr]);
        ctx.beginPath();
        ctx.moveTo(Math.round(x0 * hr) + 0.5, 0);
        ctx.lineTo(Math.round(x0 * hr) + 0.5, height * vr);
        ctx.stroke();
        ctx.fillStyle = c.pathBand;
        ctx.beginPath();
        ctx.moveTo(x0 * hr, y0 * vr);
        for (const p of steps) ctx.lineTo(fx(p.t), fy(p.hi));
        for (const p of [...steps].reverse()) ctx.lineTo(fx(p.t), fy(p.lo));
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = c.path;
        ctx.lineWidth = 1.5 * hr;
        ctx.beginPath();
        ctx.moveTo(x0 * hr, y0 * vr);
        for (const p of steps) ctx.lineTo(fx(p.t), fy(p.v));
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = c.path;
        for (const p of steps) {
          ctx.beginPath();
          ctx.arc(fx(p.t), fy(p.v), 1.8 * hr, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    // The trades: buys hang under the price and sales sit over it, stacked where they'd touch,
    // each stack tied to the price by a stem and a dot (chartMarkLayout.ts).
    const spots: MarkSpot<MarkItem>[] = [];
    const spot = (item: MarkItem, t: number, side: "buy" | "sell", r: number) => {
      const x = s.x(t);
      const v = s.valueAt(t);
      const range = s.rangeAt(t);
      const priceY = v === null ? null : s.y(v);
      const edgeY = range === null ? priceY : s.y(side === "buy" ? range.lo : range.hi);
      if (x === null || priceY === null || edgeY === null || x < -r || x > width + r) return;
      spots.push({ item, side, x, priceY, edgeY, r });
    };
    // The trader's own first, so they take the places nearest the price.
    const scale = s.markScale > 0 ? s.markScale : 1;
    for (const tr of s.trades) spot({ trade: tr }, tr.t, tr.side, 8 * scale);
    for (const m of s.marks)
      spot({ mark: m }, m.t, m.side, (s.pic(m) ? picRadius(m.sol) : markRadius(m.sol)) * scale);
    const placed = layoutMarks(spots, MARK_PITCH * scale, height);
    this.placed = placed;
    // Stems first, under every mark: from the price's dot to the mark.
    for (const p of placed) {
      const color = p.side === "buy" ? c.buy : c.sell;
      const toward = p.side === "buy" ? p.y - p.r : p.y + p.r;
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = hr;
      ctx.beginPath();
      ctx.moveTo(Math.round(p.x * hr) + 0.5, p.priceY * vr);
      ctx.lineTo(Math.round(p.x * hr) + 0.5, toward * vr);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(p.x * hr, p.priceY * vr, 2.2 * hr, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.textAlign = "center";
    for (const p of placed) {
      const { x, y, r } = p;
      if (p.item.trade) {
        // The trader's own: an arrow at the price, B or S on it.
        const buy = p.side === "buy";
        ctx.fillStyle = buy ? c.buy : c.sell;
        ctx.beginPath();
        ctx.moveTo(x * hr, (buy ? y - r : y + r) * vr);
        ctx.lineTo((x - r) * hr, (buy ? y + r * 0.7 : y - r * 0.7) * vr);
        ctx.lineTo((x + r) * hr, (buy ? y + r * 0.7 : y - r * 0.7) * vr);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = c.page;
        ctx.font = `800 ${Math.round(8.5 * vr)}px ${c.font}`;
        ctx.fillText(buy ? "B" : "S", x * hr, (buy ? y + 1.5 : y - 1) * vr);
      } else {
        const m = p.item.mark;
        const hot = s.hot.has(m) || p.more.some((o) => !!o.mark && s.hot.has(o.mark));
        const pic = s.pic(m);
        if (pic) {
          // A KOL's picture in a ring of the trade's colour: green for a buy, red for a sale.
          ctx.save();
          ctx.beginPath();
          ctx.arc(x * hr, y * vr, r * hr, 0, Math.PI * 2);
          ctx.fillStyle = c.surface;
          ctx.fill();
          ctx.clip();
          ctx.drawImage(pic, (x - r) * hr, (y - r) * vr, 2 * r * hr, 2 * r * vr);
          ctx.restore();
          ctx.beginPath();
          ctx.arc(x * hr, y * vr, (r + 0.5) * hr, 0, Math.PI * 2);
          ctx.lineWidth = (hot ? 3 : 2) * hr;
          ctx.strokeStyle = p.side === "buy" ? c.buy : c.sell;
          ctx.stroke();
        } else {
          // A lettered ring in the wallet kind's colour: filled for a buy, hollow for a sale.
          const k = c.wk(m.kind);
          ctx.beginPath();
          ctx.arc(x * hr, y * vr, r * hr, 0, Math.PI * 2);
          ctx.globalAlpha = hot ? 1 : 0.92;
          ctx.fillStyle = m.side === "buy" ? k.fill : c.surface;
          ctx.fill();
          ctx.lineWidth = (hot ? 2.5 : 1.5) * hr;
          ctx.strokeStyle = k.fill;
          if (m.side === "sell") ctx.setLineDash([2.5 * hr, 1.5 * hr]);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.globalAlpha = 1;
          ctx.fillStyle = m.side === "buy" ? c.page : k.ink;
          ctx.font = `750 ${Math.round((r >= 8 ? 9.5 : 8) * vr)}px ${c.font}`;
          ctx.fillText(m.letter, x * hr, (y + 0.5) * vr);
        }
      }
      if (p.more.length > 0) {
        // The rest of a full stack, counted on its outermost mark.
        const text = `+${p.more.length}`;
        ctx.font = `700 ${Math.round(9 * vr)}px ${c.font}`;
        const w = ctx.measureText(text).width / hr + 8;
        const bx = x + r * 0.55;
        const by = y - r * 0.85;
        ctx.fillStyle = c.labelBg;
        roundRect(ctx, bx * hr, (by - 6.5) * vr, w * hr, 13 * vr, 6.5 * hr);
        ctx.fill();
        ctx.strokeStyle = c.event;
        ctx.lineWidth = hr;
        ctx.stroke();
        ctx.fillStyle = c.eventText;
        ctx.fillText(text, (bx + w / 2) * hr, (by + 0.5) * vr);
      }
    }
    ctx.restore();

    if (s.drawings && s.drawScale) s.drawings.draw(ctx, hr, vr, s.drawScale, c.draw, s.label, width, height);
  }
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
