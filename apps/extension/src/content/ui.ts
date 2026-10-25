import { trenchUrl } from "../panel/card";
import { DEFAULT_SETTINGS } from "../shared/settings";
import {
  colorVars,
  DEFAULT_COLORS,
  DEFAULT_TOOLTIP,
  MAP_LABELS,
  shownLines,
  type ColorKey,
  type MapLine,
  type TipLine,
} from "../shared/tooltip";
import type { FlagId, OverlayBubbleTotals, RingStyle, OverlayToken } from "../shared/types";
import type { PillSegment } from "../shared/pill";
import { firstAlert, type RowVerdict } from "../shared/verdict";
import { findSpot, obstaclesIn, stillFits, type Box } from "./placement";

/**
 * What the overlay draws: a ring and a badge inside each tracked row, and one shared tooltip.
 *
 * Everything sits in closed shadow roots, so the site's CSS can't restyle it and the site's
 * scripts can't reach in. The ring ignores the mouse (every click still reaches the site); the
 * badge is the only hover target. Text from the token (names, filter names, the AI's reasoning)
 * is written with textContent only, never as HTML: whoever launched a token chose its name.
 */

const RING_CSS = `
:host { all: initial; position: absolute; inset: 0; pointer-events: none; z-index: 5; }
.ring { position: absolute; inset: 0; border-radius: 6px; }
.model { --a: var(--c-model); --b: var(--c-model2); }
.filter { --a: var(--c-filter); --b: var(--c-filter2); }
.both { --a: var(--c-model); --b: var(--c-filter); }
.risk { --a: var(--c-risk); --b: var(--c-risk2); }
.halo::before { content: ""; position: absolute; inset: 0; border-radius: inherit; padding: 1.5px;
  background: conic-gradient(from var(--ang, 0deg), var(--a), var(--b), transparent 40%, transparent 60%, var(--a));
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0); -webkit-mask-composite: xor; mask-composite: exclude;
  animation: sweep 6s linear infinite; }
.halo::after { content: ""; position: absolute; inset: 0; border-radius: inherit;
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--a) 35%, transparent), inset 0 0 22px -8px var(--a); }
.calm.halo::before { animation: none; }
.brackets::before, .brackets::after { content: ""; position: absolute; width: 18px; height: 18px; border: 2px solid var(--a); }
.brackets::before { top: 3px; left: 3px; border-right: 0; border-bottom: 0; border-radius: 6px 0 0 0; }
.brackets::after { bottom: 3px; right: 3px; border-left: 0; border-top: 0; border-radius: 0 0 6px 0; border-color: var(--b); }
.rail::before { content: ""; position: absolute; left: 0; top: 8px; bottom: 8px; width: 3px; border-radius: 0 3px 3px 0;
  background: linear-gradient(var(--a), var(--b)); box-shadow: 0 0 10px var(--a); }
.rail::after { content: ""; position: absolute; inset: 0; background: linear-gradient(90deg, color-mix(in srgb, var(--a) 10%, transparent), transparent 45%); }
@property --ang { syntax: "<angle>"; initial-value: 0deg; inherits: false; }
@keyframes sweep { to { --ang: 360deg; } }
@media (prefers-reduced-motion: reduce) { .halo::before { animation: none; } }
.badge { position: absolute; top: 4px; right: 4px; pointer-events: auto; cursor: default; display: inline-flex; align-items: center; gap: 5px;
  font: 500 10.5px/1.4 ui-monospace, "SF Mono", Menlo, Consolas, monospace; padding: 1px 7px 1px 5px; border-radius: 999px;
  background: color-mix(in srgb, var(--c-pillBg) 92%, transparent); border: 1px solid var(--a); color: var(--c-pillText); white-space: nowrap; max-width: 60%; overflow: hidden; text-overflow: ellipsis; }
.badge i { width: 7px; height: 7px; border-radius: 50%; background: var(--a); box-shadow: 0 0 6px var(--a); flex: none; }
.badge.dot { padding: 3px; gap: 0; }
.badge.dot > span, .badge.dot b { display: none; }
.badge b { width: 6px; height: 6px; border-radius: 50%; background: var(--c-risk); flex: none; }
.badge .sep { color: color-mix(in srgb, var(--c-pillText) 40%, var(--c-pillBg)); }
.badge .ok { color: var(--c-ok); } .badge .mid { color: var(--c-mid); } .badge .hi { color: var(--c-hi); }
.badge.more { border-style: dashed; }
.badge.more i { display: none; }
.badge.gone { display: none; }
`;

/** A shadow root's colours: its own style rule, rewritten only when they change. */
class ColorRule {
  readonly node = document.createElement("style");
  private text = "";
  constructor() {
    this.set(DEFAULT_COLORS);
  }
  set(colors: Record<ColorKey, string>): void {
    const text = `:host { ${colorVars(colors)} }`;
    if (text !== this.text) this.node.textContent = this.text = text;
  }
}

/** What a ring's pills say: the first pill, the second (null while off), and the risk dot. */
export interface Pills {
  main: PillSegment[];
  more: PillSegment[] | null;
  riskDot: boolean;
  colors: Record<ColorKey, string>;
}

/** A pill's text as spans, written with textContent only (a filter's name is the reader's text). */
function fill(target: HTMLElement, segments: readonly PillSegment[]): string {
  const parts: Node[] = [];
  for (const [i, seg] of segments.entries()) {
    if (i > 0) {
      const sep = document.createElement("span");
      sep.className = "sep";
      sep.textContent = " · ";
      parts.push(sep);
    }
    const span = document.createElement("span");
    if (seg.level) span.className = seg.level;
    span.textContent = seg.text;
    parts.push(span);
  }
  const key = segments.map((s) => `${s.level ?? ""}:${s.text}`).join("|");
  if (target.dataset.key !== key) {
    target.replaceChildren(...parts);
    target.dataset.key = key;
  }
  return key;
}

export interface DecorationOptions {
  style: RingStyle;
  calm: boolean;
  onHover(badge: Element, entering: boolean): void;
}

/** One row's ring and badge. Re-attached if the site's renderer removes it. */
export class Decoration {
  readonly host: HTMLElement;
  private readonly ring: HTMLDivElement;
  private readonly badge: HTMLSpanElement;
  private readonly badgeText: HTMLSpanElement;
  private readonly riskDot: HTMLElement;
  private readonly more: HTMLSpanElement;
  private readonly moreText: HTMLSpanElement;
  private readonly colors = new ColorRule();
  private madeRelative = false;
  /** What placing decided, kept apart from what each redraw paints, so a redraw can't undo it. */
  private dotOnly = false;
  private moreFits = false;
  /** Where each pill sits now (row coordinates), kept while it still fits so it doesn't jump. */
  private badgeAt: Box | null = null;
  private moreAt: Box | null = null;
  private kind = "";
  private hasMain = false;
  private hasMore = false;
  private placedFor = "";
  private placedAt = 0;
  private placeFrame = 0;

  constructor(
    private readonly row: HTMLElement,
    private readonly options: DecorationOptions,
  ) {
    this.host = document.createElement("trench-overlay");
    const root = this.host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = RING_CSS;
    this.ring = document.createElement("div");
    this.badge = document.createElement("span");
    this.badge.className = "badge";
    this.badge.append(document.createElement("i"));
    this.badgeText = document.createElement("span");
    this.riskDot = document.createElement("b");
    this.badge.append(this.badgeText);
    this.more = document.createElement("span");
    this.more.className = "badge more gone";
    this.more.append(document.createElement("i"));
    this.moreText = document.createElement("span");
    this.more.append(this.moreText);
    for (const pill of [this.badge, this.more]) {
      pill.addEventListener("mouseenter", () => options.onHover(pill, true));
      pill.addEventListener("mouseleave", () => options.onHover(pill, false));
    }
    root.append(style, this.colors.node, this.ring, this.badge, this.more);
  }

  update(verdict: RowVerdict, style: RingStyle, calm: boolean, pills: Pills): void {
    if (!verdict.ring) {
      this.remove();
      return;
    }
    this.ring.className = `ring ${verdict.ring} ${style}${calm ? " calm" : ""}`;
    this.colors.set(pills.colors);
    this.kind = verdict.ring;
    this.hasMain = pills.main.length > 0;
    this.hasMore = (pills.more?.length ?? 0) > 0;
    const before = `${this.badgeText.dataset.key}/${this.moreText.dataset.key}`;
    fill(this.badgeText, pills.main);
    fill(this.moreText, pills.more ?? []);
    const changed = before !== `${this.badgeText.dataset.key}/${this.moreText.dataset.key}`;
    if (pills.riskDot && verdict.risky && verdict.ring !== "risk") this.badge.append(this.riskDot);
    else this.riskDot.remove();
    this.paint();
    this.attach();
    if (changed) this.placedFor = "";
    this.schedulePlace();
  }

  /** The pills' classes from the ring and what placing decided. */
  private paint(): void {
    this.badge.className = `badge ${this.kind}${!this.hasMain || this.dotOnly ? " dot" : ""}`;
    this.more.className = `badge more ${this.kind}${this.hasMore && this.moreFits ? "" : " gone"}`;
  }

  /** Re-place after the next layout; cheap to call often (rows re-render all the time). */
  schedulePlace(): void {
    if (this.placeFrame) return;
    this.placeFrame = requestAnimationFrame(() => {
      this.placeFrame = 0;
      this.place();
    });
  }

  /**
   * Moves the badge into the row's first empty space; falls back to the dot alone when the
   * label fits nowhere, and to the top-right corner when even the dot doesn't. Re-measured when
   * the row's size changes, and at most once a second otherwise.
   */
  private place(): void {
    if (!this.attached) return;
    const rect = this.row.getBoundingClientRect();
    const key = `${Math.round(rect.width)}x${Math.round(rect.height)}`;
    const now = performance.now();
    if (key === this.placedFor && now - this.placedAt < 1000) return;
    this.placedFor = key;
    this.placedAt = now;

    const obstacles = obstaclesIn(this.row, this.host);
    const row = { w: rect.width, h: rect.height };
    // Measured at full size, then the dot alone if the label fits nowhere.
    this.dotOnly = false;
    this.moreFits = this.hasMore;
    this.paint();
    let first = this.spotFor(this.badge, row, obstacles, this.badgeAt);
    if (!first && this.hasMain) {
      this.dotOnly = true;
      this.paint();
      first = this.spotFor(this.badge, row, obstacles, null);
    }
    this.badgeAt = first;
    // The top-right corner when even the dot doesn't fit.
    const badge = first ?? { x: rect.width - this.badge.offsetWidth - 4, y: 4, w: 0, h: 0 };
    this.put(this.badge, badge);

    // The second pill takes the next free patch, clear of the first; left out when none fits.
    let next: Box | null = null;
    if (this.hasMore) {
      const taken = { x: badge.x, y: badge.y, w: this.badge.offsetWidth, h: this.badge.offsetHeight };
      next = this.spotFor(this.more, row, [...obstacles, taken], this.moreAt);
    }
    this.moreAt = next;
    this.moreFits = next !== null;
    this.paint();
    if (next) this.put(this.more, next);
  }

  /** Where a pill goes: where it is, while that still fits, else the first free spot. */
  private spotFor(
    pill: HTMLElement,
    row: { w: number; h: number },
    obstacles: Box[],
    at: Box | null,
  ): Box | null {
    const w = pill.offsetWidth;
    const h = pill.offsetHeight;
    if (at && stillFits(row, obstacles, { x: at.x, y: at.y, w, h })) return { x: at.x, y: at.y, w, h };
    const spot = findSpot(row, obstacles, w, h);
    return spot ? { ...spot, w, h } : null;
  }

  /** The host sits inside the row's border; spots are measured from its outer edge. */
  private put(pill: HTMLElement, at: { x: number; y: number }): void {
    pill.style.left = `${Math.round(at.x - this.row.clientLeft)}px`;
    pill.style.top = `${Math.round(at.y - this.row.clientTop)}px`;
    pill.style.right = "auto";
  }

  attach(): void {
    if (this.host.parentElement === this.row) return;
    const position = getComputedStyle(this.row).position;
    if (position === "" || position === "static") {
      this.row.style.position = "relative";
      this.madeRelative = true;
    }
    this.row.append(this.host);
  }

  remove(): void {
    cancelAnimationFrame(this.placeFrame);
    this.placeFrame = 0;
    this.placedFor = "";
    this.host.remove();
    if (this.madeRelative) {
      this.row.style.position = "";
      this.madeRelative = false;
    }
  }

  get attached(): boolean {
    return this.host.isConnected;
  }
}

const TIP_CSS = `
:host { all: initial; position: fixed; z-index: 2147483000; pointer-events: none; }
.tip { --dim: color-mix(in srgb, var(--c-tipText) 50%, var(--c-tipBg)); --soft: color-mix(in srgb, var(--c-tipText) 80%, var(--c-tipBg));
  --edge: color-mix(in srgb, var(--c-tipText) 14%, var(--c-tipBg));
  width: 300px; background: var(--c-tipBg); border: 1px solid var(--edge); border-radius: 12px; color: var(--c-tipText);
  font: 12.5px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; overflow: hidden;
  box-shadow: 0 18px 50px -12px rgba(0,0,0,0.8), 0 0 0 1px color-mix(in srgb, var(--c-model) 8%, transparent); pointer-events: auto; }
.head { display: flex; justify-content: space-between; gap: 8px; padding: 9px 12px; border-bottom: 1px solid var(--edge); }
.brand { font: 500 10px/1.6 ui-monospace, Menlo, monospace; letter-spacing: .08em; text-transform: uppercase; color: var(--dim); }
.sym { font: 500 11px/1.5 ui-monospace, Menlo, monospace; color: var(--soft); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sec { padding: 9px 12px; display: flex; flex-direction: column; gap: 6px; border-bottom: 1px solid var(--edge); }
.sec:last-child { border-bottom: 0; }
.line { display: flex; justify-content: space-between; gap: 10px; align-items: baseline; }
.l { color: var(--dim); } .r { text-align: right; font-variant-numeric: tabular-nums; }
.tag { font: 500 10px/1.5 ui-monospace, Menlo, monospace; padding: 1px 6px; border-radius: 4px; margin-right: 6px; }
.tm { background: color-mix(in srgb, var(--c-model) 16%, transparent); color: var(--c-model2); }
.tf { background: color-mix(in srgb, var(--c-filter) 15%, transparent); color: var(--c-filter2); }
.tb { background: color-mix(in srgb, var(--c-ok) 16%, transparent); color: var(--c-ok); }
.tn { background: color-mix(in srgb, var(--c-hi) 14%, transparent); color: var(--c-hi); }
.why { color: var(--soft); font-size: 11.5px; }
.ok { color: var(--c-ok); } .mid { color: var(--c-mid); } .hi { color: var(--c-hi); }
.foot { display: flex; justify-content: space-between; color: var(--dim); font-size: 11px; }
a { color: var(--c-link); text-decoration: none; }
`;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function line(left: string | Node, right: string, rightClass = ""): HTMLDivElement {
  const row = el("div", "line");
  const l = el("span", "l");
  l.append(left);
  row.append(l, el("span", `r ${rightClass}`.trim(), right));
  return row;
}

function usd(value: number | null | undefined): string {
  if (value === null || value === undefined) return "–";
  if (value >= 1e6) return `$${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `$${(value / 1e3).toFixed(1)}K`;
  return `$${Math.round(value)}`;
}

function ago(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

/**
 * The tooltip's content for one token: the reader's chosen lines, in their order (shared/tooltip.ts).
 * `totals` is the coin's bubble map totals: undefined while they're read, null when there are none.
 * Exported for tests: it must never parse token text as HTML.
 */
export function tooltipBody(
  token: OverlayToken,
  verdict: RowVerdict,
  lines: readonly TipLine[] = shownLines(DEFAULT_TOOLTIP, DEFAULT_SETTINGS),
  totals?: OverlayBubbleTotals | null,
  now = Date.now(),
): HTMLElement {
  const tip = el("div", "tip");
  const head = el("div", "head");
  head.append(
    el("span", "brand", "TrenchScanner"),
    el("span", "sym", `${token.symbol ?? "?"} · ${token.mint.slice(0, 4)}…${token.mint.slice(-4)}`),
  );
  tip.append(head);

  // Alert lines group in one section, stat lines in the next, the foot last; each in the reader's order.
  const alerts = el("div", "sec");
  const stats = el("div", "sec");
  const foot = el("div", "sec foot");
  const flags = new Map(verdict.flags.map((f) => [f.id, f]));
  for (const id of lines) {
    if (id === "models") {
      for (const call of token.modelCalls) {
        const label = el("span");
        label.append(el("span", "tag tm", "MODEL"), call.name ?? call.model);
        alerts.append(
          line(
            label,
            call.calibratedPct === null
              ? `${Math.round(call.confidence)}`
              : `${Math.round(call.calibratedPct)}% to 2x`,
          ),
        );
      }
    } else if (id === "filters") {
      for (const match of token.filterMatches) {
        const label = el("span");
        label.append(el("span", "tag tf", "FILTER"), match.filterName);
        alerts.append(line(label, `matched ${ago(match.at, now)}`));
      }
    } else if (id === "ai") {
      if (!token.ai) continue;
      const label = el("span");
      const buy = token.ai.decision === "buy";
      label.append(el("span", `tag ${buy ? "tb" : "tn"}`, `AI · ${token.ai.decision.toUpperCase()}`));
      alerts.append(
        line(
          label,
          token.ai.probability2x === null ? "" : `${Math.round(token.ai.probability2x * 100)}% to 2x`,
        ),
      );
    } else if (id === "aiReasoning") {
      if (token.ai?.reasoning) alerts.append(el("p", "why", token.ai.reasoning));
    } else if (id === "mcap") {
      const first = firstAlert(token)?.mcapUsd ?? null;
      const nowMcap = token.liveMcapUsd ?? token.stats?.marketCapUsd ?? null;
      if (first !== null) {
        const change =
          nowMcap === null
            ? ""
            : ` (${nowMcap >= first ? "+" : ""}${Math.round(((nowMcap - first) / first) * 100)}%)`;
        stats.append(line("Alerted at", `${usd(first)} · now ${usd(nowMcap)}${change}`));
      } else {
        stats.append(line("Market cap", usd(nowMcap)));
      }
    } else if (id === "holders") {
      const count = token.stats?.holderCount;
      if (count !== null && count !== undefined) stats.append(line("Holders", String(count)));
    } else if (id.startsWith("flag:")) {
      const flag = flags.get(id.slice(5) as FlagId);
      if (flag) stats.append(line(flag.label, flag.text, flag.level));
    } else if (id.startsWith("map:")) {
      const key = id.slice(4) as MapLine;
      const value = totals === undefined ? undefined : (totals?.[key] ?? null);
      // Hidden when the coin has no reading; "…" while it's read.
      if (value === null) continue;
      stats.append(line(MAP_LABELS[key].label, value === undefined ? "…" : `${Math.round(value)}%`));
    } else if (id === "statsAge") {
      foot.append(
        el("span", "", token.stats ? `Stats as of ${ago(token.stats.takenAt, now)}` : "No stats yet"),
      );
    } else if (id === "link") {
      const link = el("a", "", "Open in TrenchScanner ↗");
      link.href = trenchUrl(token.mint);
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      foot.append(link);
    }
  }
  for (const sec of [alerts, stats, foot]) if (sec.childElementCount > 0) tip.append(sec);
  return tip;
}

/** The one tooltip on the page, placed beside the hovered badge and kept on screen. */
export class Tooltip {
  private readonly host: HTMLElement;
  private readonly root: ShadowRoot;
  private hideTimer: number | undefined;
  private anchor: Element | null = null;
  private readonly colors = new ColorRule();

  constructor() {
    this.host = document.createElement("trench-overlay-tip");
    this.root = this.host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = TIP_CSS;
    this.root.append(style, this.colors.node);
    this.host.addEventListener("mouseenter", () => window.clearTimeout(this.hideTimer));
    this.host.addEventListener("mouseleave", () => this.hide());
  }

  // Listened for only while the tooltip shows (audit 2026-10-25): no key listener sits on the page otherwise.
  private readonly onKey = (e: KeyboardEvent) => e.key === "Escape" && this.hideNow();
  private readonly onScroll = () => this.hideNow();

  /** The tooltip is up beside this badge (a late read redraws it only then). */
  showing(anchor: Element): boolean {
    return this.anchor === anchor && this.host.isConnected;
  }

  show(anchor: Element, body: HTMLElement, colors: Record<ColorKey, string> = DEFAULT_COLORS): void {
    this.colors.set(colors);
    window.clearTimeout(this.hideTimer);
    this.anchor = anchor;
    document.addEventListener("keydown", this.onKey);
    window.addEventListener("scroll", this.onScroll, { capture: true, passive: true });
    this.root.querySelector(".tip")?.remove();
    this.root.append(body);
    if (!this.host.isConnected) document.documentElement.append(this.host);
    const a = anchor.getBoundingClientRect();
    const width = 300;
    const left = Math.min(Math.max(8, a.right - width), window.innerWidth - width - 8);
    const below = a.bottom + 8;
    const height = body.getBoundingClientRect().height || 260;
    const top = below + height > window.innerHeight - 8 ? Math.max(8, a.top - height - 8) : below;
    this.host.style.left = `${left}px`;
    this.host.style.top = `${top}px`;
  }

  hide(): void {
    window.clearTimeout(this.hideTimer);
    this.hideTimer = window.setTimeout(() => this.hideNow(), 120);
  }

  hideNow(): void {
    window.clearTimeout(this.hideTimer);
    this.anchor = null;
    document.removeEventListener("keydown", this.onKey);
    window.removeEventListener("scroll", this.onScroll, { capture: true });
    this.host.remove();
  }
}
