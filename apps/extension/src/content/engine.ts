import type { SiteAdapter } from "./adapters/adapter";
import { Decoration, SafetyMark, safetyBody, Tooltip, tooltipBody } from "./ui";
import { isTokenPage } from "./tokenPage";
import { columnOf, findColumns, type BoardColumn } from "./columns";
import { Scoper, type Scope } from "./scope";
import { pillSegments } from "../shared/pill";
import {
  colorsOf,
  DEFAULT_TOOLTIP,
  needsMap,
  pastLimits,
  pillParts,
  pillsNeedMap,
  shownLines,
  signalLook,
  snoozed,
  type PillPart,
  type TooltipPrefs,
} from "../shared/tooltip";
import { SITES } from "../shared/types";
import type {
  LookupAnswer,
  OverlayBubbleTotals,
  OverlaySafety,
  OverlaySettings,
  OverlayToken,
  SafetyAnswer,
  StatsAnswer,
} from "../shared/types";
import { verdictFor } from "../shared/verdict";

/** How long the rows on screen go before they are asked about again (new alerts land this way). */
const REFRESH_MS = 15_000;
/** Lookup answers kept before old ones are pruned, as the board's and safety's caches are. */
const MAX_ANSWERS = 5_000;
/**
 * A lookup goes out this soon after rows change, so one burst of mutations makes one ask, and
 * while they keep changing (a scroll) at least this often, rather than only once they stop
 * (user ask 2026-10-26: rings were slow to follow a scroll).
 */
const LOOKUP_SOON_MS = 30;
const LOOKUP_EVERY_MS = 120;
/**
 * The safety screen's asks go to TrenchScanner (120 a minute per account), so they go out at most
 * this often, and a coin already asked about isn't asked again until that answer lands.
 */
const SAFETY_EVERY_MS = 600;
/** A board coin's numbers are asked for again after this long (the scan lands every few minutes). */
const BOARD_STATS_MS = 30_000;
/** A board pill's parts when none of the reader's own pill parts has a number for the coin. */
const BOARD_FALLBACK: PillPart[] = ["mcap", "holders"];
/** At most this many coins per ask, the ones on screen first (the worker takes 100). */
const LOOKUP_MAX = 100;
/** Rows found but no address read for this long: the adapter no longer fits the page. */
const PAUSE_AFTER_MS = 10_000;
/** The board's column boxes are looked for again after this long, while the safety option is on. */
const COLUMNS_MS = 2_000;
/** A coin's map totals are asked for again after this long (the worker keeps them a minute too). */
const TOTALS_MS = 60_000;
/**
 * A row's place among the page's layers (scope.ts) is worked out again after this long. Working it
 * out reads the layout of every box around the row, so it isn't done on every scan.
 */
const SCOPE_MS = 5_000;
/** Pills on screen are re-placed this often, as the site's numbers beside them grow and shrink. */
const PLACE_MS = 2_000;
/** Our own elements, which never call for a scan. */
const OURS = /^TRENCH-OVERLAY/;

/**
 * A change that can add, remove or recycle a row: an element in or out, or a watched attribute
 * (a link, a picture, an address mark). A price, age or count ticking over replaces text only, and
 * a busy board does that dozens of times a second (2026-10-28: scanning on each tick took most of
 * the overlay's CPU).
 */
export function structural(records: readonly MutationRecord[]): boolean {
  for (const r of records) {
    if (r.type === "attributes") return true;
    if (r.type !== "childList") continue;
    for (const list of [r.addedNodes, r.removedNodes]) {
      for (let i = 0; i < list.length; i++) {
        const node = list[i]!;
        if (node.nodeType === Node.ELEMENT_NODE && !OURS.test(node.nodeName)) return true;
      }
    }
  }
  return false;
}

/**
 * The slot a virtual list places a row in: the nearest box (the row itself, or up to four levels
 * above it) placed by an inline `top` or `translateY`, as Axiom's, Terminal's and GMGN's lists do.
 */
export function slotOf(row: HTMLElement): HTMLElement | null {
  let el: HTMLElement | null = row;
  for (let i = 0; el && i < 5; el = el.parentElement, i++) {
    if (el.style.position === "absolute" && el.style.top !== "") return el;
    if (/translateY\(/.test(el.style.transform)) return el;
  }
  return null;
}

/** Where the list put a slot, from its own inline style (our `translate` is not part of it). */
function slotY(slot: HTMLElement): number {
  const top = Number.parseFloat(slot.style.top);
  if (Number.isFinite(top)) return top;
  const y = /translateY\((-?[\d.]+)px\)/.exec(slot.style.transform);
  return y ? Number(y[1]) : slot.offsetTop;
}

function slotHeight(slot: HTMLElement): number {
  const h = Number.parseFloat(slot.style.height);
  return Number.isFinite(h) ? h : slot.offsetHeight;
}

export interface EngineDeps {
  lookup(mints: string[]): Promise<LookupAnswer>;
  /** The rows found and the addresses read, when they change (tests read it; the tab sends nothing). */
  report?(health: { rows: number; mints: number; paused: boolean }): void;
  /** A tracked coin's bubble map totals, for the tooltip; null when there are none or the read failed. */
  totals?(mint: string): Promise<OverlayBubbleTotals | null>;
  /** The safety verdicts of coins on screen, while the hide-or-mark option is on. */
  safety?(mints: string[]): Promise<SafetyAnswer>;
  /** The stats of coins on screen, while the pill-on-every-coin option or the limits are on. */
  stats?(mints: string[]): Promise<StatsAnswer>;
  /** The tooltip's Snooze: the worker saves it, and every tab redraws without the coin. */
  snooze?(mint: string, minutes: number): void;
  /** The tooltip's Look up: the side panel opens on the coin. */
  openCoin?(mint: string): void;
}

interface RowState {
  mint: string | null;
  decoration: Decoration | null;
  /** The X over a coin failing the safety screen, in "mark" mode. */
  mark: SafetyMark | null;
  /** The row is hidden for failing it, in "hide" mode. */
  hidden: boolean;
  /** The row is dimmed for being past the reader's limits. */
  dimmed: boolean;
  /** The virtual list's slot it was hidden in, when it sits in one (slotOf). */
  slot: HTMLElement | null;
}

/**
 * Watches one page: finds token rows as the site renders and recycles them, asks about the
 * visible ones, and draws on the tracked ones. It reads nothing but each row's address.
 */
export class OverlayEngine {
  private readonly rows = new Map<HTMLElement, RowState>();
  private readonly visible = new Set<HTMLElement>();
  private readonly tokens = new Map<string, { at: number; token: OverlayToken | null }>();
  private readonly tooltip = new Tooltip();
  private readonly totals = new Map<string, { at: number; totals: OverlayBubbleTotals | null }>();
  private readonly totalsAsked = new Set<string>();
  private readonly safety = new Map<string, { at: number; verdict: OverlaySafety | null }>();
  /** Coins that aren't the reader's alerts, with TrenchScanner's numbers, for the board pills. */
  private readonly board = new Map<string, { at: number; token: OverlayToken | null }>();
  private lastStats = 0;
  private readonly statsAsked = new Set<string>();
  private columns: { at: number; boxes: [Element, BoardColumn][] } = { at: 0, boxes: [] };
  private tipPrefs: TooltipPrefs = DEFAULT_TOOLTIP;
  private mutation: MutationObserver | null = null;
  private intersection: IntersectionObserver | null = null;
  private frame = 0;
  private batchTimer: number | undefined;
  private lookupForce = false;
  private lastLookup = 0;
  private lastSafety = 0;
  private readonly safetyAsked = new Set<string>();
  private refreshTimer: number | undefined;
  private placeTimer: number | undefined;
  /** One wait for the safety screen's or the board's next ask, however many lookups found it too soon. */
  private retryTimer: number | undefined;
  private noMintSince: number | null = null;
  private paused = false;
  private lastReport = "";
  /** Each row's scope, kept SCOPE_MS on the page it was read on. */
  private scopes = new WeakMap<HTMLElement, { at: number; scope: Scope }>();
  private scopePath = "";

  constructor(
    private readonly adapter: SiteAdapter,
    private settings: OverlaySettings,
    private readonly deps: EngineDeps,
  ) {}

  start(): void {
    this.intersection = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const row = entry.target as HTMLElement;
        if (entry.isIntersecting) this.visible.add(row);
        else this.visible.delete(row);
      }
      this.queueLookup();
    });
    this.mutation = new MutationObserver((records) => {
      if (structural(records)) this.schedule();
    });
    this.mutation.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: this.adapter.watchedAttributes,
    });
    this.refreshTimer = window.setInterval(() => this.queueLookup(true), REFRESH_MS);
    this.placeTimer = window.setInterval(() => this.replace(), PLACE_MS);
    document.addEventListener("visibilitychange", this.onVisibility);
    this.schedule();
  }

  /** A tab brought back asks about its rows at once; a hidden one asks nothing (lookupVisible). */
  private readonly onVisibility = () => {
    if (document.visibilityState === "visible") this.queueLookup(true);
  };

  /** The pills on screen, re-placed if the row's text moved under them (at most once a second each). */
  private replace(): void {
    if (document.visibilityState !== "visible") return;
    for (const row of this.visible) this.rows.get(row)?.decoration?.schedulePlace();
  }

  stop(): void {
    this.mutation?.disconnect();
    this.intersection?.disconnect();
    window.clearInterval(this.refreshTimer);
    window.clearInterval(this.placeTimer);
    window.clearTimeout(this.batchTimer);
    window.clearTimeout(this.retryTimer);
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.batchTimer = undefined;
    this.retryTimer = undefined;
    cancelAnimationFrame(this.frame);
    for (const [row, state] of this.rows) {
      state.decoration?.remove();
      this.clearSafety(row, state);
    }
    this.closeGaps();
    this.rows.clear();
    this.visible.clear();
    this.tooltip.hideNow();
  }

  applySettings(settings: OverlaySettings): void {
    this.settings = settings;
    for (const [row, state] of this.rows) this.draw(row, state);
  }

  applyTooltip(prefs: TooltipPrefs): void {
    const asked =
      (prefs.safety.mode !== "off" && this.tipPrefs.safety.mode === "off") ||
      (prefs.boardStats.enabled && !this.tipPrefs.boardStats.enabled) ||
      (prefs.limits.mode !== "off" && this.tipPrefs.limits.mode === "off");
    this.tipPrefs = prefs;
    for (const [row, state] of this.rows) this.draw(row, state);
    this.closeGaps();
    if (asked) this.queueLookup(true);
  }

  /** A coin's map totals, read again once they're older than TOTALS_MS; its rows redraw on arrival. */
  private loadTotals(mint: string): Promise<void> | null {
    const cached = this.totals.get(mint);
    if (!this.deps.totals || this.totalsAsked.has(mint)) return null;
    if (cached && Date.now() - cached.at < TOTALS_MS) return null;
    this.totalsAsked.add(mint);
    return this.deps.totals(mint).then((totals) => {
      this.totalsAsked.delete(mint);
      this.totals.set(mint, { at: Date.now(), totals });
      for (const [row, state] of this.rows) if (state.mint === mint) this.draw(row, state);
    });
  }

  /** The tooltip for a hovered badge, redrawn once the coin's map totals arrive if it needs them. */
  private showTip(badge: Element, mint: string): void {
    // A board coin's pill has the same tooltip, from its numbers alone.
    const current = () => this.tokens.get(mint)?.token ?? this.boardToken(mint);
    const token = current();
    if (!token) return;
    const draw = () => {
      const live = current() ?? token;
      const lines = shownLines(this.tipPrefs, this.settings);
      this.tooltip.show(
        badge,
        tooltipBody(live, verdictFor(live, this.settings), lines, this.totals.get(mint)?.totals, Date.now(), {
          sites: SITES.filter((site) => this.settings.sites[site] && site !== this.adapter.site),
          lookUp: (m) => this.deps.openCoin?.(m),
          snooze: (m, minutes) => {
            this.deps.snooze?.(m, minutes);
            this.tooltip.hideNow();
          },
        }),
        colorsOf(this.tipPrefs),
      );
    };
    draw();
    if (!needsMap(this.tipPrefs, this.settings)) return;
    void this.loadTotals(mint)?.then(() => {
      if (this.tooltip.showing(badge)) draw();
    });
  }

  /** One pass per frame however many mutations arrive. */
  private schedule(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.scan();
    });
  }

  /** Exposed for tests, which have no animation frames. */
  scan(now = Date.now()): void {
    const found = this.inScope(this.adapter.findRows(document) as HTMLElement[]);
    const current = new Set(found);
    for (const [row, state] of this.rows) {
      if (!current.has(row) || !row.isConnected) {
        state.decoration?.remove();
        this.clearSafety(row, state);
        this.intersection?.unobserve(row);
        this.visible.delete(row);
        this.rows.delete(row);
      }
    }
    // Rows can change column when the boxes are found again: every row is drawn again then.
    let redrawAll = false;
    if (
      this.screening() &&
      (now - this.columns.at >= COLUMNS_MS || this.columns.boxes.some(([b]) => !b.isConnected))
    ) {
      this.columns = { at: now, boxes: findColumns(document, found) };
      redrawAll = true;
    }
    let withMint = 0;
    const fresh = new Set<HTMLElement>();
    for (const row of found) {
      const mint = this.adapter.mintOf(row);
      if (mint) withMint++;
      let state = this.rows.get(row);
      if (!state) {
        state = { mint: null, decoration: null, mark: null, hidden: false, dimmed: false, slot: null };
        this.rows.set(row, state);
        this.intersection?.observe(row);
        fresh.add(row);
      }
      // A recycled row now shows another token: drop what was drawn for the last one.
      if (state.mint !== mint) {
        state.decoration?.remove();
        this.clearSafety(row, state);
        state.mint = mint;
        fresh.add(row);
      }
    }
    if (this.checkHealth(found.length, withMint, now)) redrawAll = true;
    // A row drawn already is drawn again only when its answers change (receive and the rest draw
    // it then) or the site's renderer undid what was drawn; on its own a scan reads, not writes.
    for (const row of found) {
      const state = this.rows.get(row)!;
      if (redrawAll || fresh.has(row) || this.undone(row, state)) this.draw(row, state);
      else state.decoration?.schedulePlace();
    }
    this.closeGaps();
    this.queueLookup();
  }

  /** The site's renderer took away what was drawn on the row: the ring, the X, or a hidden or dimmed style. */
  private undone(row: HTMLElement, state: RowState): boolean {
    if (state.decoration && !state.decoration.attached) return true;
    if (state.mark && !state.mark.attached) return true;
    if (state.dimmed && row.style.getPropertyPriority("opacity") !== "important") return true;
    if (state.hidden) {
      const target = state.slot ?? row;
      const prop = state.slot ? "visibility" : "display";
      if (target.style.getPropertyPriority(prop) !== "important") return true;
    }
    return false;
  }

  /**
   * The rows rings may go on (scope.ts): in the page's own lists or a full search menu, never a
   * quick search, tooltip or popover; on a coin's own page, only a board column's or a search menu's.
   */
  private inScope(rows: HTMLElement[]): HTMLElement[] {
    const scoper = new Scoper();
    const tokenPage = isTokenPage(this.adapter.site, location.pathname);
    const now = Date.now();
    if (location.pathname !== this.scopePath) {
      this.scopePath = location.pathname;
      this.scopes = new WeakMap();
    }
    return rows.filter((row) => {
      let known = this.scopes.get(row);
      if (!known || now - known.at >= SCOPE_MS) {
        known = { at: now, scope: scoper.of(row) };
        this.scopes.set(row, known);
      }
      const scope = known.scope;
      if (scope === "search") return true;
      return scope === "page" && (!tokenPage || this.adapter.inColumn(row));
    });
  }

  /** Pauses when the adapter no longer fits the page; true when it resumes, so every row is drawn again. */
  private checkHealth(rows: number, mints: number, now: number): boolean {
    let resumed = false;
    if (rows > 0 && mints === 0) {
      this.noMintSince ??= now;
      if (!this.paused && now - this.noMintSince >= PAUSE_AFTER_MS) {
        this.paused = true;
        for (const [row, state] of this.rows) {
          state.decoration?.remove();
          this.clearSafety(row, state);
        }
      }
    } else {
      this.noMintSince = null;
      resumed = this.paused;
      this.paused = false;
    }
    const report = `${rows}/${mints}/${this.paused}`;
    if (report !== this.lastReport) {
      this.lastReport = report;
      this.deps.report?.({ rows, mints, paused: this.paused });
    }
    return resumed;
  }

  /** Throttled, not debounced: rows changing again doesn't push the pending ask back. */
  private queueLookup(force = false): void {
    if (force) this.lookupForce = true;
    if (this.batchTimer !== undefined) return;
    const wait = Math.max(LOOKUP_SOON_MS, this.lastLookup + LOOKUP_EVERY_MS - Date.now());
    this.batchTimer = window.setTimeout(() => {
      this.batchTimer = undefined;
      this.lastLookup = Date.now();
      const forced = this.lookupForce;
      this.lookupForce = false;
      void this.lookupVisible(forced);
    }, wait);
  }

  /**
   * Asks about the rows the page has rendered, those on screen first: a virtual list renders a
   * few rows past each edge of its column, so the rows a scroll brings in are usually answered
   * before they arrive. The ring lookup is answered from the worker's copy of the feed; the
   * safety screen, only while it is on, sends these addresses to TrenchScanner.
   */
  private async lookupVisible(force: boolean): Promise<void> {
    // A tab in the background asks nothing: it asks again the moment it is shown (onVisibility).
    if (this.paused || document.visibilityState === "hidden") return;
    const now = Date.now();
    const wanted = new Set<string>();
    const unsafe = new Set<string>();
    const screening = this.screening();
    const rows = [...this.rows].sort(([a], [b]) => Number(this.visible.has(b)) - Number(this.visible.has(a)));
    for (const [, state] of rows) {
      const mint = state.mint;
      if (!mint) continue;
      const known = this.tokens.get(mint);
      if (force || !known || now - known.at >= REFRESH_MS) wanted.add(mint);
      // A hidden row is never on screen, so it is asked about while hidden, to show it once it passes.
      const verdict = this.safety.get(mint);
      if (screening && !this.safetyAsked.has(mint) && (force || !verdict || now - verdict.at >= REFRESH_MS))
        unsafe.add(mint);
    }
    // The board pills: coins the lookup says aren't alerts. Asked as the safety screen is.
    const stats = new Set<string>();
    if (this.boardNumbersOn()) {
      for (const [, state] of rows) {
        const mint = state.mint;
        if (!mint || this.statsAsked.has(mint)) continue;
        const known = this.tokens.get(mint);
        if (!known || known.token) continue;
        const had = this.board.get(mint);
        if (force || !had || now - had.at >= BOARD_STATS_MS) stats.add(mint);
      }
      if (stats.size > 0 && now - this.lastStats < SAFETY_EVERY_MS) {
        this.retry(force, this.lastStats + SAFETY_EVERY_MS - now);
        stats.clear();
      }
    }
    // Too soon for another safety ask: the next lookup after the wait carries it.
    const safetyDue = now - this.lastSafety >= SAFETY_EVERY_MS;
    if (unsafe.size > 0 && !safetyDue) {
      this.retry(force, this.lastSafety + SAFETY_EVERY_MS - now);
      unsafe.clear();
    }
    await Promise.all([
      wanted.size > 0 &&
        this.deps.lookup([...wanted].slice(0, LOOKUP_MAX)).then((answer) => {
          if (!answer.problem) this.receive([...wanted].slice(0, LOOKUP_MAX), answer, now);
        }),
      unsafe.size > 0 && this.deps.safety && this.readSafety([...unsafe].slice(0, LOOKUP_MAX), now),
      stats.size > 0 && this.readStats([...stats].slice(0, LOOKUP_MAX), now),
    ]);
  }

  /** Looks again once the wait is over; a wait already set carries this one (one timer, not one per lookup). */
  private retry(force: boolean, wait: number): void {
    if (force) this.lookupForce = true;
    if (this.retryTimer !== undefined) return;
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = undefined;
      this.queueLookup();
    }, wait);
  }

  /** The hide-or-mark option applies here: it is on, and this is a board, not a coin's page. */
  private screening(): boolean {
    return (
      this.tipPrefs.safety.mode !== "off" &&
      !!this.deps.safety &&
      !isTokenPage(this.adapter.site, location.pathname)
    );
  }

  /** The board pills apply: the option is on and the worker can answer. */
  private boardStatsOn(): boolean {
    return this.tipPrefs.boardStats.enabled && !!this.deps.stats;
  }

  /** The board's numbers are wanted: for its pills, or for the reader's limits on a board. */
  private boardNumbersOn(): boolean {
    return (
      !!this.deps.stats &&
      (this.tipPrefs.boardStats.enabled ||
        (this.tipPrefs.limits.mode !== "off" && !isTokenPage(this.adapter.site, location.pathname)))
    );
  }

  private async readStats(mints: string[], now: number): Promise<void> {
    this.lastStats = now;
    for (const mint of mints) this.statsAsked.add(mint);
    const answer = await this.deps.stats!(mints).finally(() => {
      for (const mint of mints) this.statsAsked.delete(mint);
    });
    if (answer.problem) return;
    this.receiveStats(mints, answer, now);
  }

  /** Exposed for tests. A coin left out of the answer has no numbers, so it gets no pill. */
  receiveStats(asked: string[], answer: StatsAnswer, now = Date.now()): void {
    for (const mint of asked) this.board.set(mint, { at: now, token: answer.tokens[mint] ?? null });
    if (this.board.size > 5_000) {
      for (const [mint, v] of this.board) if (now - v.at > 10 * BOARD_STATS_MS) this.board.delete(mint);
    }
    this.drawFor(asked);
    // Coins hidden past the reader's limits leave a gap in a virtual list otherwise.
    if (this.tipPrefs.limits.mode === "hide") this.closeGaps();
  }

  private async readSafety(mints: string[], now: number): Promise<void> {
    this.lastSafety = now;
    for (const mint of mints) this.safetyAsked.add(mint);
    const answer = await this.deps.safety!(mints).finally(() => {
      for (const mint of mints) this.safetyAsked.delete(mint);
    });
    if (answer.problem) return;
    this.receiveSafety(mints, answer, now);
  }

  /** Exposed for tests. A coin left out of the answer was never screened, so it is shown. */
  receiveSafety(asked: string[], answer: SafetyAnswer, now = Date.now()): void {
    this.applySafety(asked, answer, now);
    this.closeGaps();
  }

  private applySafety(asked: string[], answer: SafetyAnswer, now: number): void {
    for (const mint of asked) this.safety.set(mint, { at: now, verdict: answer.verdicts[mint] ?? null });
    if (this.safety.size > 5_000) {
      for (const [mint, v] of this.safety) if (now - v.at > 10 * REFRESH_MS) this.safety.delete(mint);
    }
    this.drawFor(asked);
  }

  /** A board coin's token, when the option is on and its numbers are no older than the reader allows. */
  private boardToken(mint: string): OverlayToken | null {
    return this.boardStatsOn() ? this.freshBoardToken(mint) : null;
  }

  /** A board coin's numbers, when they are no older than the reader allows. */
  private freshBoardToken(mint: string): OverlayToken | null {
    const token = this.board.get(mint)?.token;
    const at = token?.stats ? Date.parse(token.stats.takenAt) : NaN;
    if (!token || !Number.isFinite(at)) return null;
    return Date.now() - at <= this.tipPrefs.boardStats.maxAgeMinutes * 60_000 ? token : null;
  }

  /** Hides the row, marks it, or leaves it, by its coin's newest verdict and the reader's choice. */
  private drawSafety(row: HTMLElement, state: RowState): void {
    const verdict =
      state.mint && !this.paused && this.screening() ? this.safety.get(state.mint)?.verdict : null;
    const failed =
      verdict?.passed === false && this.tipPrefs.safety.columns[columnOf(row, this.columns.boxes)];
    const mode = this.tipPrefs.safety.mode;
    // The reader's own limits (user ask 2026-10-27), on the numbers the coin's alert or the board's
    // read brought; a coin's own page is never dimmed or hidden.
    const numbers =
      state.mint &&
      !this.paused &&
      this.tipPrefs.limits.mode !== "off" &&
      !isTokenPage(this.adapter.site, location.pathname)
        ? (this.tokens.get(state.mint)?.token ?? this.freshBoardToken(state.mint))
        : null;
    const past = numbers ? pastLimits(this.tipPrefs, numbers.stats).length > 0 : false;
    const limitMode = this.tipPrefs.limits.mode;
    this.dim(row, state, past && limitMode === "dim");
    if ((failed && mode === "hide") || (past && limitMode === "hide")) {
      state.mark?.remove();
      state.mark = null;
      // In a virtual list the slot keeps its place, so it is hidden and the slots below move up
      // into it (closeGaps); elsewhere the row is taken out of the flow. Set again on each draw:
      // the site's renderer may rewrite the style.
      state.slot ??= slotOf(row);
      const target = state.slot ?? row;
      const [prop, value] = state.slot ? ["visibility", "hidden"] : ["display", "none"];
      if (target.style.getPropertyValue(prop) !== value) target.style.setProperty(prop, value, "important");
      state.hidden = true;
      return;
    }
    this.showRow(row, state);
    if (failed && mode === "mark") {
      state.mark ??= new SafetyMark(row, (tag, entering) => {
        const shown = state.mint ? this.safety.get(state.mint)?.verdict : null;
        if (entering && state.mint && shown)
          this.tooltip.show(tag, safetyBody(state.mint, shown), colorsOf(this.tipPrefs));
        else this.tooltip.hide();
      });
      state.mark.update(colorsOf(this.tipPrefs));
    } else {
      state.mark?.remove();
      state.mark = null;
    }
  }

  /** Dims the row past the reader's limits, or undoes it. */
  private dim(row: HTMLElement, state: RowState, on: boolean): void {
    if (!on && !state.dimmed) return;
    if (on) {
      if (row.style.getPropertyValue("opacity") !== "0.35")
        row.style.setProperty("opacity", "0.35", "important");
      state.dimmed = true;
    } else {
      if (row.style.getPropertyPriority("opacity") === "important") row.style.removeProperty("opacity");
      state.dimmed = false;
    }
  }

  private showRow(row: HTMLElement, state: RowState): void {
    if (!state.hidden) return;
    if (state.slot) {
      if (state.slot.style.getPropertyPriority("visibility") === "important")
        state.slot.style.removeProperty("visibility");
    } else if (row.style.getPropertyPriority("display") === "important") row.style.removeProperty("display");
    state.hidden = false;
    state.slot = null;
  }

  /** Slots this moved up, so it can put them back. */
  private readonly shifted = new Set<HTMLElement>();

  /**
   * Closes the gaps hidden rows leave in a virtual list (user ask 2026-10-25): each slot below a
   * hidden one moves up by the hidden slots' heights, with the CSS `translate` property, which
   * adds to the site's own `top` or `transform` rather than replacing it. Only the slots the list
   * has rendered count: one scrolled far out of it no longer pulls the rest up.
   */
  private closeGaps(): void {
    const hidden = new Set<HTMLElement>();
    const lists = new Set<HTMLElement>();
    for (const state of this.rows.values()) {
      if (state.hidden && state.slot?.parentElement) {
        hidden.add(state.slot);
        lists.add(state.slot.parentElement);
      }
    }
    const moved = new Set<HTMLElement>();
    for (const list of lists) {
      const slots = [...list.children].filter((c): c is HTMLElement => c instanceof HTMLElement);
      slots.sort((a, b) => slotY(a) - slotY(b));
      let shift = 0;
      for (const slot of slots) {
        if (hidden.has(slot)) {
          shift += slotHeight(slot);
          continue;
        }
        if (shift === 0) continue;
        slot.style.setProperty("translate", `0 -${shift}px`);
        moved.add(slot);
      }
    }
    for (const slot of this.shifted) if (!moved.has(slot)) slot.style.removeProperty("translate");
    this.shifted.clear();
    for (const slot of moved) this.shifted.add(slot);
  }

  private clearSafety(row: HTMLElement, state: RowState): void {
    this.showRow(row, state);
    this.dim(row, state, false);
    state.mark?.remove();
    state.mark = null;
  }

  /** Draws again the rows showing these coins. */
  private drawFor(mints: readonly string[]): void {
    const asked = new Set(mints);
    for (const [row, state] of this.rows) if (state.mint && asked.has(state.mint)) this.draw(row, state);
  }

  /** Exposed for tests: how many coins' lookup answers are kept. */
  get answerCount(): number {
    return this.tokens.size;
  }

  /** Exposed for tests. */
  receive(asked: string[], answer: LookupAnswer, now = Date.now()): void {
    for (const mint of asked) this.tokens.set(mint, { at: now, token: answer.tokens[mint] ?? null });
    // A long-open board sees thousands of coins scroll past: old answers go, as the board's and the
    // safety screen's do, except for coins still on a row (audit CE-6, EX-9).
    if (this.tokens.size > MAX_ANSWERS) {
      const onRows = new Set([...this.rows.values()].map((state) => state.mint));
      for (const [mint, v] of this.tokens) {
        if (now - v.at > 10 * REFRESH_MS && !onRows.has(mint)) this.tokens.delete(mint);
      }
    }
    this.drawFor(asked);
  }

  private draw(row: HTMLElement, state: RowState): void {
    this.drawSafety(row, state);
    const alerted = state.mint ? this.tokens.get(state.mint)?.token : null;
    // Not an alert: the board pill, while its option is on and its numbers are fresh enough.
    const token = alerted ?? (state.mint ? this.boardToken(state.mint) : null);
    // A snoozed coin keeps no ring or pill until it wakes (user ask 2026-10-27).
    if (!token || this.paused || snoozed(this.tipPrefs, state.mint!)) {
      state.decoration?.remove();
      return;
    }
    const found = verdictFor(token, this.settings);
    // A board coin gets no ring of its own, whatever its flags say: the plain pill only.
    const plain = !alerted;
    const verdict = plain ? { ...found, ring: null } : found;
    if (!verdict.ring && !plain) {
      state.decoration?.remove();
      return;
    }
    state.decoration ??= new Decoration(row, {
      style: this.settings.style.ring,
      calm: this.settings.style.calmMotion,
      onHover: (badge, entering) => {
        if (entering && state.mint) this.showTip(badge, state.mint);
        else this.tooltip.hide();
      },
    });
    const { main, more } = pillParts(this.tipPrefs);
    const look = signalLook(this.tipPrefs, verdict.modelId, verdict.filterId);
    const totals = this.totals.get(state.mint!)?.totals;
    if (pillsNeedMap(this.tipPrefs)) void this.loadTotals(state.mint!);
    let first = pillSegments(main, token, verdict, this.settings, totals);
    let second = more ? pillSegments(more, token, verdict, this.settings, totals) : null;
    if (plain) {
      // A board coin has no call or alert, so the name, odds, change and age parts come out empty.
      // Its pill is whatever numbers both pills have, in one, or market cap and holders failing
      // that; with nothing to say it gets no pill, never a bare dot.
      first = [...first, ...(second ?? [])];
      second = null;
      if (first.length === 0) first = pillSegments(BOARD_FALLBACK, token, verdict, this.settings, totals);
      if (first.length === 0) {
        state.decoration.remove();
        return;
      }
    }
    state.decoration.update(verdict, this.settings.style.ring, this.settings.style.calmMotion, {
      plain,
      main: first,
      more: second,
      riskDot: this.tipPrefs.riskDot,
      colors: look.colors,
      effect: look.effect,
    });
  }
}
