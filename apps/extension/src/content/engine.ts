import type { SiteAdapter } from "./adapters/adapter";
import { Decoration, SafetyMark, safetyBody, Tooltip, tooltipBody } from "./ui";
import { isTokenPage } from "./tokenPage";
import { columnOf, findColumns, type BoardColumn } from "./columns";
import { pillSegments } from "../shared/pill";
import {
  colorsOf,
  DEFAULT_TOOLTIP,
  needsMap,
  pillParts,
  pillsNeedMap,
  shownLines,
  signalLook,
  type TooltipPrefs,
} from "../shared/tooltip";
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
/** At most this many coins per ask, the ones on screen first (the worker takes 100). */
const LOOKUP_MAX = 100;
/** Rows found but no address read for this long: the adapter no longer fits the page. */
const PAUSE_AFTER_MS = 10_000;
/** The board's column boxes are looked for again after this long, while the safety option is on. */
const COLUMNS_MS = 2_000;
/** A coin's map totals are asked for again after this long (the worker keeps them a minute too). */
const TOTALS_MS = 60_000;

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
  report(health: { rows: number; mints: number; paused: boolean }): void;
  /** A tracked coin's bubble map totals, for the tooltip; null when there are none or the read failed. */
  totals?(mint: string): Promise<OverlayBubbleTotals | null>;
  /** The safety verdicts of coins on screen, while the hide-or-mark option is on. */
  safety?(mints: string[]): Promise<SafetyAnswer>;
  /** The stats of coins on screen, while the pill-on-every-coin option is on. */
  stats?(mints: string[]): Promise<StatsAnswer>;
}

interface RowState {
  mint: string | null;
  decoration: Decoration | null;
  /** The X over a coin failing the safety screen, in "mark" mode. */
  mark: SafetyMark | null;
  /** The row is hidden for failing it, in "hide" mode. */
  hidden: boolean;
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
  private noMintSince: number | null = null;
  private paused = false;

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
    this.mutation = new MutationObserver(() => this.schedule());
    this.mutation.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["href", "src"],
    });
    this.refreshTimer = window.setInterval(() => this.queueLookup(true), REFRESH_MS);
    this.schedule();
  }

  stop(): void {
    this.mutation?.disconnect();
    this.intersection?.disconnect();
    window.clearInterval(this.refreshTimer);
    window.clearTimeout(this.batchTimer);
    this.batchTimer = undefined;
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
      (prefs.boardStats.enabled && !this.tipPrefs.boardStats.enabled);
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
        tooltipBody(live, verdictFor(live, this.settings), lines, this.totals.get(mint)?.totals),
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
    const found = this.adapter.findRows(document) as HTMLElement[];
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
    if (
      this.screening() &&
      (now - this.columns.at >= COLUMNS_MS || this.columns.boxes.some(([b]) => !b.isConnected))
    )
      this.columns = { at: now, boxes: findColumns(document, found) };
    let withMint = 0;
    for (const row of found) {
      const mint = this.adapter.mintOf(row);
      if (mint) withMint++;
      let state = this.rows.get(row);
      if (!state) {
        state = { mint: null, decoration: null, mark: null, hidden: false, slot: null };
        this.rows.set(row, state);
        this.intersection?.observe(row);
      }
      // A recycled row now shows another token: drop what was drawn for the last one.
      if (state.mint !== mint) {
        state.decoration?.remove();
        this.clearSafety(row, state);
        state.mint = mint;
      }
      this.draw(row, state);
    }
    this.checkHealth(found.length, withMint, now);
    this.closeGaps();
    this.queueLookup();
  }

  private checkHealth(rows: number, mints: number, now: number): void {
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
      this.paused = false;
    }
    this.deps.report({ rows, mints, paused: this.paused });
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
    if (this.paused) return;
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
    if (this.boardStatsOn()) {
      for (const [, state] of rows) {
        const mint = state.mint;
        if (!mint || this.statsAsked.has(mint)) continue;
        const known = this.tokens.get(mint);
        if (!known || known.token) continue;
        const had = this.board.get(mint);
        if (force || !had || now - had.at >= BOARD_STATS_MS) stats.add(mint);
      }
      if (stats.size > 0 && now - this.lastStats < SAFETY_EVERY_MS) {
        window.setTimeout(() => this.queueLookup(force), this.lastStats + SAFETY_EVERY_MS - now);
        stats.clear();
      }
    }
    // Too soon for another safety ask: the next lookup after the wait carries it.
    const safetyDue = now - this.lastSafety >= SAFETY_EVERY_MS;
    if (unsafe.size > 0 && !safetyDue) {
      window.setTimeout(() => this.queueLookup(force), this.lastSafety + SAFETY_EVERY_MS - now);
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
    for (const [row, state] of this.rows) if (state.mint && asked.includes(state.mint)) this.draw(row, state);
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
    for (const [row, state] of this.rows) if (state.mint && asked.includes(state.mint)) this.draw(row, state);
  }

  /** A board coin's token, when the option is on and its numbers are no older than the reader allows. */
  private boardToken(mint: string): OverlayToken | null {
    if (!this.boardStatsOn()) return null;
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
    if (failed && mode === "hide") {
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
    state.mark?.remove();
    state.mark = null;
  }

  /** Exposed for tests. */
  receive(asked: string[], answer: LookupAnswer, now = Date.now()): void {
    for (const mint of asked) this.tokens.set(mint, { at: now, token: answer.tokens[mint] ?? null });
    for (const [row, state] of this.rows) if (state.mint && asked.includes(state.mint)) this.draw(row, state);
  }

  private draw(row: HTMLElement, state: RowState): void {
    this.drawSafety(row, state);
    const alerted = state.mint ? this.tokens.get(state.mint)?.token : null;
    // Not an alert: the board pill, while its option is on and its numbers are fresh enough.
    const token = alerted ?? (state.mint ? this.boardToken(state.mint) : null);
    if (!token || this.paused) {
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
    state.decoration.update(verdict, this.settings.style.ring, this.settings.style.calmMotion, {
      plain,
      main: pillSegments(main, token, verdict, this.settings, totals),
      more: more && pillSegments(more, token, verdict, this.settings, totals),
      riskDot: this.tipPrefs.riskDot,
      colors: look.colors,
      effect: look.effect,
    });
  }
}
