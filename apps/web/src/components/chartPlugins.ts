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
import {
  bubbleMoreCount,
  collapseBubbleSpots,
  layoutMarks,
  OWN_TRADE_BASE,
  ownTradeRadius,
  ownTradeTop,
  placeOwnTrades,
  type MarkSpot,
  type OwnTradeSpot,
  type PlacedMark,
} from "../chartMarkLayout";
import { markRadius, type MarkShape, type WalletMark } from "../walletMarks";

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
  coarse?: boolean;
}

export interface SlotCandleOptions extends CustomSeriesOptions {
  upColor: string;
  downColor: string;
  flatColor: string;
}

/**
 * The candle series: the library's own draws every candle one slot wide, so a candle coarser than
 * the timeframe (a minute candle where the 1-second ones don't reach) would squeeze into one slot
 * and leave a gap after it. This one draws it across the slots it covers, at its real width,
 * shaded (COARSE_ALPHA) so it doesn't pass for a candle of the timeframe picked.
 */
/** How opaque a candle wider than the timeframe draws. */
const COARSE_ALPHA = 0.4;

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
        // A slot nobody read is whitespace: nothing to draw (chartBars.ts `unknown`).
        if (d.c === undefined) continue;
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
        ctx.globalAlpha = d.coarse ? COARSE_ALPHA : 1;
        const wx = Math.round(cx * hr) - Math.floor(wickW / 2);
        ctx.fillRect(wx, Math.round(yh * vr), wickW, Math.max(1, Math.round((yl - yh) * vr)));
        const bx = Math.round((cx - bodyW / 2) * hr);
        const bw = Math.max(1, Math.round(bodyW * hr));
        const top = Math.round(Math.min(yo, yc) * vr);
        ctx.fillRect(bx, top, bw, Math.max(1, Math.round(Math.abs(yc - yo) * vr)));
      }
      ctx.globalAlpha = 1;
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

/** DexScreener token info, paid or updated, drawn in the same band as the trade bubbles. */
export interface OverlayDexInfo {
  t: number;
  /** The readout line: "DexScreener token info paid 2h ago". */
  text: string;
  updated: boolean;
}

/** What a placed mark on the chart is: a labeled wallet's trade, the trader's own, or DexScreener info. */
export type MarkItem =
  | { mark: WalletMark; trade?: undefined; dex?: undefined }
  | { trade: OverlayTrade; mark?: undefined; dex?: undefined }
  | { dex: OverlayDexInfo; mark?: undefined; trade?: undefined };

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
  /** DexScreener token-info bubble. Distinct from a dev's mark. */
  dex: string;
  /** A stretch with no data: its shading, its edges, and the backfilling label's bar. */
  gap: string;
  gapEdge: string;
  gapBar: string;
  /** A wallet mark's colour and its text's, by kind (walletMarks.ts MarkKind). */
  wk: (kind: string) => { fill: string; ink: string };
  draw: DrawColors;
}

/** A stretch of slots with no data, by its edges' times (ms): the first slot's start, the last's end. */
export interface OverlayGap {
  t0: number;
  t1: number;
}

/** The label over a gap: its line, a second one, and its bar's fill (0 to 1; null: no bar). */
export interface GapNote {
  title: string;
  sub: string | null;
  fill: number | null;
}

/** What the overlay draws, set by the chart on each render. */
export interface OverlayState {
  /** A time (ms) and a market cap to CSS px on the plot; null off it. */
  x: (t: number) => number | null;
  y: (v: number) => number | null;
  /** The market cap the line or candles show at a time (ms). */
  valueAt: (t: number) => number | null;
  /** The low and high there (the candle's; the price itself on the line). Marks clear the high. */
  rangeAt: (t: number) => { lo: number; hi: number } | null;
  /**
   * Y of the highest candle in view (smaller is higher). Trade bubbles do not use it: they sit
   * a grid line above their own candle. Kept so a caller can still measure the series.
   */
  seriesTop: () => number | null;
  /** The bar a time falls in. Bubbles group wallets that share a bar, not every nearby trade. */
  column: (t: number) => number;
  /**
   * One horizontal grid line, in price, at this candle high. 0 when the scale is not ready.
   * On a log scale this is the chart's own scale at that price, not a linear tick of the pane.
   */
  gridStep: (atPrice: number) => number;
  /** How many of those grid lines a trade bubble's bottom sits above the candle high. */
  bubbleSteps: number;
  events: OverlayEvent[];
  /** How far down the plot the events' flags start (px), clear of the readout. */
  flagTop: number;
  /** The words on each flag. Off draws the vertical line only. */
  eventLabels: boolean;
  /** Size of those flags, as a factor of the medium size (chartEvents.ts eventFlagMetrics). */
  eventScale: number;
  marks: WalletMark[];
  trades: OverlayTrade[];
  /** DexScreener token-info payment, when the orders response gave a time. */
  dexInfo: OverlayDexInfo | null;
  /** The predicted path, from the latest reading, drawn in the zone past the last candle. */
  path: PathStep[];
  pathZone: { x0: number; w: number } | null;
  /** The wallet marks under the pointer, drawn stronger. */
  hot: ReadonlySet<WalletMark>;
  /** A KOL's picture, once loaded (null: none, not yet, or it failed: the lettered ring shows). */
  pic: (mark: WalletMark) => CanvasImageSource | null;
  /** How big the trade marks draw (Customize › Chart wallet trades). */
  markScale: number;
  /** Lettered wallet marks. Pictures stay round; the trader's own buys and sells stay arrows. */
  markShape: MarkShape;
  /** The line and the dot from a mark to the price. Off unless the reader turns it on. */
  markStem: boolean;
  /** How far the stack sits from the price, as a factor of today's pitch (1). */
  markGap: number;
  drawings: Drawings | null;
  drawScale: DrawScale | null;
  label: (v: number) => string;
  colors: OverlayColors | null;
  /** The stretches with no data, oldest first, shaded and labelled. */
  gaps: OverlayGap[];
  /** A slot edge's time (ms) to x (CSS px). */
  edgeX: (t: number) => number | null;
  /** The label each gap in view shows, read as it draws (its ETA counts down). */
  gapNote: () => GapNote;
}

/**
 * Everything the chart marks over its candles, as one series primitive: the alert and model lines
 * with their flags along the top, labeled wallets' trades as lettered marks (a circle, square or
 * diamond, filled for a buy, sized by SOL) or KOLs' pictures, the trader's own B and S triangles
 * just under the candle they traded, a DexScreener token-info bubble when its payment time is
 * known, an optional line to the candle, the predicted path, and the drawings. Letter and picture
 * bubbles sit a grid line or two above their own candle (chartMarkLayout.ts). The trader's own
 * triangles do not: they anchor to the candle low.
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

  /**
   * The stretches with no data: shaded top to bottom between dashed edges, each with a label
   * centred on the part of it in view (so a reader who sees any of it sees the label): that its
   * history is being backfilled, with a bar and an ETA, or that no source had it.
   */
  private drawGaps(
    ctx: CanvasRenderingContext2D,
    hr: number,
    vr: number,
    width: number,
    height: number,
    c: OverlayColors,
  ): void {
    const s = this.state;
    if (s.gaps.length === 0) return;
    let note: GapNote | null = null;
    for (const g of s.gaps) {
      const a = s.edgeX(g.t0);
      const b = s.edgeX(g.t1);
      if (a === null || b === null || b < 0 || a > width || !(b > a)) continue;
      const left = Math.max(0, a);
      const right = Math.min(width, b);
      ctx.fillStyle = c.gap;
      ctx.fillRect(left * hr, 0, (right - left) * hr, height * vr);
      ctx.strokeStyle = c.gapEdge;
      ctx.lineWidth = hr;
      ctx.setLineDash([3 * hr, 3 * hr]);
      for (const x of [a, b]) {
        if (x < 0 || x > width) continue;
        ctx.beginPath();
        ctx.moveTo(Math.round(x * hr) + 0.5, 0);
        ctx.lineTo(Math.round(x * hr) + 0.5, height * vr);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      note ??= s.gapNote();
      // A narrow gap in view gets its label too: drawn over its middle, kept on the plot.
      ctx.font = `700 ${Math.round(11 * vr)}px ${c.font}`;
      const plain = note.fill === null && !note.sub;
      const w = Math.min(plain ? ctx.measureText(note.title).width / hr + 20 : GAP_LABEL_W, width - 8);
      const x = Math.min(width - w - 4, Math.max(4, (left + right) / 2 - w / 2));
      const h = plain ? 26 : GAP_LABEL_H;
      const y = Math.max(4, height / 2 - h / 2);
      ctx.fillStyle = c.labelBg;
      roundRect(ctx, x * hr, y * vr, w * hr, h * vr, 8 * hr);
      ctx.fill();
      ctx.strokeStyle = c.gapEdge;
      ctx.lineWidth = hr;
      ctx.stroke();
      ctx.textBaseline = "middle";
      ctx.textAlign = "left";
      ctx.fillStyle = c.eventText;
      ctx.font = `700 ${Math.round(11 * vr)}px ${c.font}`;
      ctx.fillText(clip(ctx, note.title, (w - 20) * hr), (x + 10) * hr, (y + 13) * vr);
      if (note.sub) {
        ctx.font = `500 ${Math.round(10 * vr)}px ${c.font}`;
        ctx.globalAlpha = 0.75;
        ctx.textAlign = "right";
        ctx.fillText(note.sub, (x + w - 10) * hr, (y + 13) * vr);
        ctx.textAlign = "left";
        ctx.globalAlpha = 1;
      }
      if (note.fill !== null) {
        const bx = x + 10;
        const bw = w - 20;
        const by = y + h - 15;
        ctx.fillStyle = c.gap;
        roundRect(ctx, bx * hr, by * vr, bw * hr, 6 * vr, 3 * hr);
        ctx.fill();
        ctx.fillStyle = c.gapBar;
        roundRect(ctx, bx * hr, by * vr, Math.max(6, bw * note.fill) * hr, 6 * vr, 3 * hr);
        ctx.fill();
      }
    }
  }

  private draw(ctx: CanvasRenderingContext2D, hr: number, vr: number, width: number): void {
    const s = this.state;
    const c = s.colors;
    if (!c) return;
    const height = ctx.canvas.height / vr;
    ctx.save();
    ctx.textBaseline = "middle";

    this.drawGaps(ctx, hr, vr, width, height, c);

    // The alert and model lines, dashed top to bottom, each flagged along the top; flags that
    // would touch move down a row. The same events the horizontal price lines use. Labels can
    // be off; the line stays. Size is the reader's (medium is today's).
    const factor = s.eventScale > 0 && Number.isFinite(s.eventScale) ? s.eventScale : 1;
    const rows: number[] = [];
    ctx.font = `600 ${Math.round(10.5 * factor * vr)}px ${c.font}`;
    const events = s.events
      .map((e) => ({ e, x: s.x(e.t) }))
      .filter((e): e is { e: OverlayEvent; x: number } => e.x !== null && e.x >= 0 && e.x <= width)
      .sort((a, b) => a.x - b.x);
    for (const { e, x } of events) {
      ctx.strokeStyle = e.lead ? c.eventLead : c.event;
      ctx.lineWidth = (e.lead ? 1.5 : 1) * factor * hr;
      ctx.setLineDash([4 * hr, 4 * hr]);
      ctx.beginPath();
      ctx.moveTo(Math.round(x * hr) + 0.5, 0);
      ctx.lineTo(Math.round(x * hr) + 0.5, height * vr);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    if (s.eventLabels) {
      const pillH = 16 * factor;
      const rowH = 19 * factor;
      const padX = 12 * factor;
      const textPad = 6 * factor;
      for (const { e, x } of events) {
        if (!e.label) continue;
        const w = ctx.measureText(e.label).width / hr + padX;
        const left = Math.min(width - w - 2, Math.max(2, x - w / 2));
        let row = rows.findIndex((end) => end + 4 <= left);
        if (row < 0) row = rows.length < 3 ? rows.length : rows.indexOf(Math.min(...rows));
        rows[row] = left + w;
        const y = s.flagTop + row * rowH;
        ctx.fillStyle = e.lead ? c.eventLead : c.labelBg;
        roundRect(ctx, left * hr, y * vr, w * hr, pillH * vr, 8 * factor * hr);
        ctx.fill();
        if (!e.lead) {
          ctx.strokeStyle = c.event;
          ctx.lineWidth = hr;
          ctx.stroke();
        }
        ctx.fillStyle = e.lead ? c.page : c.eventText;
        ctx.fillText(e.label, (left + textPad) * hr, (y + pillH / 2 + 0.5 * factor) * vr);
      }
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

    // Letter and picture bubbles clear their own candle by a few grid lines, in price
    // (chartMarkLayout.ts). The trader's triangles are placed under the candle low and are not
    // given a candle high, so this distance does not move them. Size scales the radius. A stack
    // is worked out at those prices, not in a band at the top of the pane.
    const spots: MarkSpot<MarkItem>[] = [];
    const spot = (item: MarkItem, t: number, side: "buy" | "sell", r: number) => {
      const x = s.x(t);
      const v = s.valueAt(t);
      const range = s.rangeAt(t);
      const priceY = v === null ? null : s.y(v);
      const edgeY = range === null ? priceY : s.y(range.hi);
      if (x === null || priceY === null || edgeY === null || x < -r || x > width + r) return;
      const hi = range?.hi;
      const gridStep = hi != null && hi > 0 ? s.gridStep(hi) : 0;
      spots.push({
        item,
        side,
        x,
        priceY,
        edgeY,
        r,
        column: s.column(t),
        ...(hi != null && hi > 0 && gridStep > 0 ? { hi, gridStep } : {}),
      });
    };
    const scale = s.markScale > 0 ? s.markScale : 1;
    const steps = s.bubbleSteps > 0 && Number.isFinite(s.bubbleSteps) ? s.bubbleSteps : 1;
    if (s.dexInfo) spot({ dex: s.dexInfo }, s.dexInfo.t, "buy", 12 * scale);
    for (const m of s.marks)
      spot({ mark: m }, m.t, m.side, (s.pic(m) ? picRadius(m.sol) : markRadius(m.sol)) * scale);
    // One bubble per KOL (with that KOL's side wallets) on a bar. The detail still lists every wallet.
    const bubbles = collapseBubbleSpots(spots, (item) => item.mark?.bubble ?? null);
    const placed = layoutMarks(bubbles, MARK_PITCH * scale, height, 1, undefined, { steps, toY: s.y });
    // The signed-in trader's own trades: a triangle just under that candle's low, in price
    // space, not in the bubble band (placeOwnTrades).
    const ownSpots: OwnTradeSpot<MarkItem>[] = [];
    const reach = ownTradeRadius(scale);
    for (const tr of s.trades) {
      const x = s.x(tr.t);
      const v = s.valueAt(tr.t);
      const range = s.rangeAt(tr.t);
      const priceY = v === null ? null : s.y(v);
      const lowY = range === null ? priceY : s.y(range.lo);
      if (x === null || priceY === null || lowY === null || x < -reach || x > width + reach) continue;
      ownSpots.push({ item: { trade: tr }, side: tr.side, x, lowY, priceY });
    }
    const own = placeOwnTrades(ownSpots, scale);
    const ownPlaced: PlacedMark<MarkItem>[] = own.map((p) => ({
      item: p.item,
      side: p.side,
      x: p.x,
      priceY: p.priceY,
      edgeY: p.lowY,
      r: p.r,
      y: p.y,
      level: p.level,
      more: p.more,
      grouped: [],
    }));
    this.placed = [...placed, ...ownPlaced];
    // The line to the candle, under every mark: from the price's dot to the mark. Off by default.
    if (s.markStem) {
      for (const p of this.placed) {
        const color = p.item.dex ? c.dex : p.side === "buy" ? c.buy : c.sell;
        // Bubbles are above the series, so the line meets the bottom of the bubble. An own-trade
        // triangle is under the candle, so the line meets its top edge.
        const toward = p.item.trade ? ownTradeTop(p.side, p.y, p.r) : p.y + p.r;
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
    }
    ctx.textAlign = "center";
    for (const p of this.placed) {
      const { x, y, r } = p;
      if (p.item.dex) {
        // DexScreener token info. "DS" is this payment, not a dev's mark (letter D).
        ctx.beginPath();
        ctx.arc(x * hr, y * vr, r * hr, 0, Math.PI * 2);
        ctx.fillStyle = c.dex;
        ctx.globalAlpha = 0.95;
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.lineWidth = 1.5 * hr;
        ctx.strokeStyle = c.page;
        ctx.stroke();
        ctx.fillStyle = c.page;
        ctx.font = `800 ${Math.round(Math.max(7, r * 0.7) * vr)}px ${c.font}`;
        ctx.fillText("DS", x * hr, (y + 0.5) * vr);
      } else if (p.item.trade) {
        // The trader's own: a triangle on the candle, B or S on it. A buy points up at the
        // candle; a sell points down. The light stroke keeps either one readable on the wick.
        const buy = p.side === "buy";
        ctx.beginPath();
        ctx.moveTo(x * hr, (buy ? y - r : y + r) * vr);
        ctx.lineTo((x - r) * hr, (buy ? y + OWN_TRADE_BASE * r : y - OWN_TRADE_BASE * r) * vr);
        ctx.lineTo((x + r) * hr, (buy ? y + OWN_TRADE_BASE * r : y - OWN_TRADE_BASE * r) * vr);
        ctx.closePath();
        ctx.fillStyle = buy ? c.buy : c.sell;
        ctx.globalAlpha = 1;
        ctx.fill();
        ctx.lineJoin = "round";
        ctx.lineWidth = 2.25 * hr;
        ctx.strokeStyle = c.eventText;
        ctx.stroke();
        ctx.lineJoin = "miter";
        ctx.fillStyle = c.page;
        ctx.font = `800 ${Math.round(9.5 * vr)}px ${c.font}`;
        ctx.fillText(buy ? "B" : "S", x * hr, (buy ? y + 2 : y - 1.5) * vr);
      } else {
        const m = p.item.mark!;
        const hot =
          s.hot.has(m) ||
          p.more.some((o) => !!o.mark && s.hot.has(o.mark)) ||
          p.grouped.some((o) => !!o.mark && s.hot.has(o.mark));
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
          // A lettered mark in the wallet kind's colour: filled for a buy, hollow for a sale.
          // Circle, square or diamond. A KOL's picture stays round, and B/S stay arrows.
          const k = c.wk(m.kind);
          markOutline(ctx, s.markShape, x * hr, y * vr, r * hr);
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
          ctx.fillText(m.letter || "?", x * hr, (y + 0.5) * vr);
        }
      }
      const extra = bubbleMoreCount(p);
      if (extra > 0) {
        // Grouped wallets and a stack that ran out of rows, counted on this bubble.
        const text = `+${extra}`;
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

/** A lettered wallet mark's outline, in bitmap px: a circle, a square or a diamond. */
function markOutline(ctx: CanvasRenderingContext2D, shape: MarkShape, x: number, y: number, r: number): void {
  ctx.beginPath();
  if (shape === "square") {
    ctx.rect(x - r, y - r, r * 2, r * 2);
    return;
  }
  if (shape === "diamond") {
    ctx.moveTo(x, y - r);
    ctx.lineTo(x + r, y);
    ctx.lineTo(x, y + r);
    ctx.lineTo(x - r, y);
    ctx.closePath();
    return;
  }
  ctx.arc(x, y, r, 0, Math.PI * 2);
}

/** The backfilling label's size (CSS px). */
const GAP_LABEL_W = 176;
const GAP_LABEL_H = 46;

/** `text` cut with an ellipsis to fit `maxW` (bitmap px) in the context's font. */
function clip(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxW) t = t.slice(0, -1);
  return `${t}…`;
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
