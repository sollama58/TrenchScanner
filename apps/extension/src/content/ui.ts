import { DEFAULT_SETTINGS } from "../shared/settings";
import { DEFAULT_TOOLTIP, MAP_LABELS, shownLines, type MapLine, type TipLine } from "../shared/tooltip";
import type { FlagId, OverlayBubbleTotals, RingStyle, OverlayToken } from "../shared/types";
import type { RowVerdict } from "../shared/verdict";
import { findSpot, obstaclesIn } from "./placement";

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
.model { --a: #ff7a35; --b: #ffc35a; }
.filter { --a: #3fd7c9; --b: #8af1e7; }
.both { --a: #ff7a35; --b: #3fd7c9; }
.risk { --a: #ff4d6a; --b: #ff9db0; }
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
  background: rgba(13, 14, 18, 0.92); border: 1px solid var(--a); color: #eef0f6; white-space: nowrap; max-width: 60%; overflow: hidden; text-overflow: ellipsis; }
.badge i { width: 7px; height: 7px; border-radius: 50%; background: var(--a); box-shadow: 0 0 6px var(--a); flex: none; }
.badge.dot { padding: 3px; gap: 0; }
.badge.dot > span, .badge.dot b { display: none; }
.badge b { width: 6px; height: 6px; border-radius: 50%; background: #ff4d6a; flex: none; }
`;

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
  private madeRelative = false;
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
    this.badge.addEventListener("mouseenter", () => options.onHover(this.badge, true));
    this.badge.addEventListener("mouseleave", () => options.onHover(this.badge, false));
    root.append(style, this.ring, this.badge);
  }

  update(verdict: RowVerdict, style: RingStyle, calm: boolean): void {
    if (!verdict.ring) {
      this.remove();
      return;
    }
    this.ring.className = `ring ${verdict.ring} ${style}${calm ? " calm" : ""}`;
    this.badge.className = `badge ${verdict.ring}`;
    const text = verdict.badge ?? "";
    const changed = this.badgeText.textContent !== text;
    this.badgeText.textContent = text;
    if (verdict.risky && verdict.ring !== "risk") this.badge.append(this.riskDot);
    else this.riskDot.remove();
    this.attach();
    if (changed) this.placedFor = "";
    this.schedulePlace();
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
    this.badge.classList.remove("dot");
    let spot = findSpot(row, obstacles, this.badge.offsetWidth, this.badge.offsetHeight);
    if (!spot) {
      this.badge.classList.add("dot");
      spot = findSpot(row, obstacles, this.badge.offsetWidth, this.badge.offsetHeight);
    }
    // The host sits inside the row's border; the boxes are measured from its outer edge.
    const x = (spot?.x ?? rect.width - this.badge.offsetWidth - 4) - this.row.clientLeft;
    const y = (spot?.y ?? 4) - this.row.clientTop;
    this.badge.style.left = `${Math.round(x)}px`;
    this.badge.style.top = `${Math.round(y)}px`;
    this.badge.style.right = "auto";
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
.tip { width: 300px; background: #111218; border: 1px solid #2a2d38; border-radius: 12px; color: #eef0f6;
  font: 12.5px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; overflow: hidden;
  box-shadow: 0 18px 50px -12px rgba(0,0,0,0.8), 0 0 0 1px rgba(255,122,53,0.08); pointer-events: auto; }
.head { display: flex; justify-content: space-between; gap: 8px; padding: 9px 12px; border-bottom: 1px solid #23252e; }
.brand { font: 500 10px/1.6 ui-monospace, Menlo, monospace; letter-spacing: .08em; text-transform: uppercase; color: #7d8396; }
.sym { font: 500 11px/1.5 ui-monospace, Menlo, monospace; color: #c7cbd8; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sec { padding: 9px 12px; display: flex; flex-direction: column; gap: 6px; border-bottom: 1px solid #1f2129; }
.sec:last-child { border-bottom: 0; }
.line { display: flex; justify-content: space-between; gap: 10px; align-items: baseline; }
.l { color: #7d8396; } .r { text-align: right; font-variant-numeric: tabular-nums; }
.tag { font: 500 10px/1.5 ui-monospace, Menlo, monospace; padding: 1px 6px; border-radius: 4px; margin-right: 6px; }
.tm { background: rgba(255,122,53,.16); color: #ffb084; } .tf { background: rgba(63,215,201,.15); color: #8af1e7; }
.tb { background: rgba(61,220,132,.16); color: #7ef0ae; } .tn { background: rgba(255,77,106,.14); color: #ff8b9d; }
.why { color: #c7cbd8; font-size: 11.5px; }
.ok { color: #7ef0ae; } .mid { color: #f8d77a; } .hi { color: #ff8b9d; }
.foot { display: flex; justify-content: space-between; color: #7d8396; font-size: 11px; }
a { color: #4fd1e8; text-decoration: none; }
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
      const first = token.modelCalls[0]?.mcapUsd ?? token.filterMatches[0]?.mcapUsd ?? null;
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
      link.href = `https://trenchscanner.app/?sage=${encodeURIComponent(token.mint)}`;
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

  constructor() {
    this.host = document.createElement("trench-overlay-tip");
    this.root = this.host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = TIP_CSS;
    this.root.append(style);
    this.host.addEventListener("mouseenter", () => window.clearTimeout(this.hideTimer));
    this.host.addEventListener("mouseleave", () => this.hide());
    document.addEventListener("keydown", (e) => e.key === "Escape" && this.hideNow());
    window.addEventListener("scroll", () => this.hideNow(), { capture: true, passive: true });
  }

  /** The tooltip is up beside this badge (a late read redraws it only then). */
  showing(anchor: Element): boolean {
    return this.anchor === anchor && this.host.isConnected;
  }

  show(anchor: Element, body: HTMLElement): void {
    window.clearTimeout(this.hideTimer);
    this.anchor = anchor;
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
    this.host.remove();
  }
}
