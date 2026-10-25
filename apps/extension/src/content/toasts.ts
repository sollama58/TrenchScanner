import { siteUrl } from "../panel/card";
import { pillSegments, type PillSegment } from "../shared/pill";
import { colorsOf, colorVars, toastPartOn, type TooltipPrefs } from "../shared/tooltip";
import type { FeedAnswer, OverlayBubbleTotals, OverlaySettings, OverlayToken, Site } from "../shared/types";
import { verdictFor } from "../shared/verdict";

/**
 * The on-page alert (user asks 2026-10-25): a toast on the board when a new alert lands in the
 * reader's feed, read from the side panel's own feed through the service worker. Off until turned
 * on in Settings; which alerts, where, how long, what it says, the sound and the click are all the
 * reader's. Alerts already in the feed when the page opens are taken as seen, so a reload never
 * replays them. Token text is written with textContent only.
 */

/** How often the feed is asked about while toasts are on and the page shows. */
const POLL_MS = 10_000;
/** How long a toast waits on its coin's map totals, when it shows any. */
const TOTALS_WAIT_MS = 1_500;

const CSS = `
:host { all: initial; position: fixed; z-index: 2147483001; display: flex; flex-direction: column; gap: 8px; width: 300px; pointer-events: none; }
:host(.top-right) { top: 16px; right: 16px; } :host(.top-left) { top: 16px; left: 16px; }
:host(.bottom-right) { bottom: 16px; right: 16px; flex-direction: column-reverse; }
:host(.bottom-left) { bottom: 16px; left: 16px; flex-direction: column-reverse; }
.toast { pointer-events: auto; position: relative; background: var(--c-tipBg); color: var(--c-tipText); border-radius: 10px; padding: 9px 30px 9px 12px;
  border: 1px solid color-mix(in srgb, var(--a) 60%, transparent); box-shadow: 0 14px 40px -12px rgba(0,0,0,.8), 0 0 18px -6px var(--a);
  font: 12.5px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; animation: in .18s ease-out; }
.toast.click { cursor: pointer; }
.toast.model { --a: var(--c-model); } .toast.filter { --a: var(--c-filter); }
.head { display: flex; gap: 8px; align-items: baseline; min-width: 0; }
.tag { font: 600 10px/1.5 ui-monospace, Menlo, monospace; padding: 1px 6px; border-radius: 4px; flex: none;
  background: color-mix(in srgb, var(--a) 18%, transparent); color: var(--a); }
.name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sym { color: color-mix(in srgb, var(--c-tipText) 55%, var(--c-tipBg)); font: 500 11px ui-monospace, Menlo, monospace; flex: none; }
.parts { margin-top: 3px; font: 500 11px/1.5 ui-monospace, Menlo, monospace; }
.sep { color: color-mix(in srgb, var(--c-tipText) 35%, var(--c-tipBg)); }
.ok { color: var(--c-ok); } .mid { color: var(--c-mid); } .hi { color: var(--c-hi); }
.x { all: unset; position: absolute; top: 6px; right: 8px; cursor: pointer; font-size: 15px; line-height: 1; padding: 1px 4px; border-radius: 4px;
  color: color-mix(in srgb, var(--c-tipText) 55%, var(--c-tipBg)); }
.x:hover { color: var(--c-tipText); }
@keyframes in { from { opacity: 0; transform: translateY(-4px); } }
@media (prefers-reduced-motion: reduce) { .toast { animation: none; } }
`;

export interface ToastDeps {
  alerts(): Promise<FeedAnswer | null>;
  totals(mint: string): Promise<OverlayBubbleTotals | null>;
}

interface Shown {
  node: HTMLElement;
  timer: number | undefined;
}

export class Toasts {
  private readonly host = document.createElement("trench-overlay-toasts");
  private readonly root: ShadowRoot;
  private readonly vars = document.createElement("style");
  private readonly seen = new Set<string>();
  private readonly shown: Shown[] = [];
  private primed = false;
  private timer: number | undefined;
  private polling = false;

  constructor(
    private readonly site: Site,
    private readonly deps: ToastDeps,
    private prefs: TooltipPrefs,
    private settings: OverlaySettings,
  ) {
    this.root = this.host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = CSS;
    this.root.append(style, this.vars);
  }

  start(): void {
    this.timer = window.setInterval(() => void this.poll(), POLL_MS);
    void this.poll();
  }

  stop(): void {
    window.clearInterval(this.timer);
    for (const s of this.shown.splice(0)) window.clearTimeout(s.timer);
    this.host.remove();
  }

  apply(prefs: TooltipPrefs, settings: OverlaySettings): void {
    const wasOn = this.on;
    this.prefs = prefs;
    this.settings = settings;
    // Turned on now: what is already in the feed counts as seen.
    if (!wasOn && this.on) {
      this.primed = false;
      this.seen.clear();
    }
    if (!this.on) for (const s of [...this.shown]) this.dismiss(s);
    else void this.poll();
  }

  private get on(): boolean {
    return this.prefs.toast.enabled && this.prefs.toast.sites[this.site];
  }

  /** Exposed for tests. */
  async poll(): Promise<void> {
    if (!this.on || this.polling || document.visibilityState !== "visible") return;
    this.polling = true;
    try {
      const answer = await this.deps.alerts();
      if (!answer || answer.problem !== null) return;
      this.receive(answer.tokens);
    } finally {
      this.polling = false;
    }
  }

  /** Exposed for tests: each new call or match not seen before, toasted when it passes. */
  receive(tokens: readonly OverlayToken[]): void {
    const fresh: { token: OverlayToken; kind: "model" | "filter"; label: string }[] = [];
    for (const token of tokens) {
      for (const call of token.modelCalls) {
        const key = `m:${token.mint}:${call.model}`;
        if (this.seen.has(key)) continue;
        this.seen.add(key);
        if (this.primed && this.passes(token, call.calibratedPct))
          fresh.push({ token, kind: "model", label: call.name ?? call.model });
      }
      for (const match of token.filterMatches) {
        const key = `f:${token.mint}:${match.filterId}`;
        if (this.seen.has(key)) continue;
        this.seen.add(key);
        if (this.primed && this.prefs.toast.filters)
          fresh.push({ token, kind: "filter", label: match.filterName });
      }
    }
    this.primed = true;
    for (const f of fresh) void this.show(f.token, f.kind, f.label);
  }

  private passes(token: OverlayToken, odds: number | null): boolean {
    const t = this.prefs.toast;
    if (!t.models) return false;
    if (t.minOdds > 0 && (odds === null || odds < t.minOdds)) return false;
    if (t.aiBuyOnly && token.ai?.decision !== "buy") return false;
    return true;
  }

  private async show(token: OverlayToken, kind: "model" | "filter", label: string): Promise<void> {
    const t = this.prefs.toast;
    const parts = t.parts.order.filter((p) => toastPartOn(p, t.parts));
    let totals: OverlayBubbleTotals | null | undefined;
    if (parts.some((p) => p.startsWith("map:"))) {
      totals = await Promise.race([
        this.deps.totals(token.mint),
        new Promise<undefined>((r) => setTimeout(() => r(undefined), TOTALS_WAIT_MS)),
      ]);
    }
    const segments = pillSegments(parts, token, verdictFor(token, this.settings), this.settings, totals);

    this.host.className = t.position;
    this.vars.textContent = `:host { ${colorVars(colorsOf(this.prefs))} }`;
    if (!this.host.isConnected) document.documentElement.append(this.host);

    const node = document.createElement("div");
    node.className = `toast ${kind}${t.click === "none" ? "" : " click"}`;
    const head = document.createElement("div");
    head.className = "head";
    head.append(
      span("tag", kind === "model" ? "MODEL" : "FILTER"),
      span("name", label),
      span("sym", token.symbol ?? `${token.mint.slice(0, 4)}…`),
    );
    node.append(head);
    if (segments.length > 0) node.append(partsLine(segments));
    const x = document.createElement("button");
    x.className = "x";
    x.type = "button";
    x.textContent = "×";
    x.setAttribute("aria-label", "Dismiss");
    node.append(x);

    const entry: Shown = { node, timer: undefined };
    x.addEventListener("click", (e) => {
      e.stopPropagation();
      this.dismiss(entry);
    });
    if (t.click !== "none") {
      node.addEventListener("click", () => {
        this.dismiss(entry);
        if (t.click === "site") location.assign(siteUrl(this.site, token.mint));
        else
          window.open(
            `https://trenchscanner.app/?sage=${encodeURIComponent(token.mint)}`,
            "_blank",
            "noopener",
          );
      });
    }
    if (t.seconds > 0) entry.timer = window.setTimeout(() => this.dismiss(entry), t.seconds * 1000);
    this.root.append(node);
    this.shown.push(entry);
    while (this.shown.length > t.maxShown) this.dismiss(this.shown[0]!);
    if (t.sound) chime();
  }

  private dismiss(entry: Shown): void {
    window.clearTimeout(entry.timer);
    entry.node.remove();
    const i = this.shown.indexOf(entry);
    if (i >= 0) this.shown.splice(i, 1);
    if (this.shown.length === 0) this.host.remove();
  }
}

function span(className: string, text: string): HTMLSpanElement {
  const s = document.createElement("span");
  s.className = className;
  s.textContent = text;
  return s;
}

function partsLine(segments: readonly PillSegment[]): HTMLElement {
  const line = document.createElement("div");
  line.className = "parts";
  segments.forEach((seg, i) => {
    if (i > 0) line.append(span("sep", " · "));
    line.append(span(seg.level ?? "", seg.text));
  });
  return line;
}

/** A short two-note chime, made here (no sound file); silent where the page may not play audio. */
function chime(): void {
  try {
    const ctx = new AudioContext();
    const now = ctx.currentTime;
    for (const [i, freq] of [880, 1320].entries()) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, now + i * 0.12);
      gain.gain.exponentialRampToValueAtTime(0.12, now + i * 0.12 + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.12 + 0.18);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + i * 0.12);
      osc.stop(now + i * 0.12 + 0.2);
    }
    setTimeout(() => void ctx.close(), 600);
  } catch {
    // No audio here: the toast still shows.
  }
}
