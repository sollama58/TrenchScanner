import type { SiteAdapter } from "./adapters/adapter";
import { Decoration, SafetyMark, Tooltip, tooltipBody } from "./ui";
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
} from "../shared/types";
import { verdictFor } from "../shared/verdict";

/** How long the rows on screen go before they are asked about again (new alerts land this way). */
const REFRESH_MS = 15_000;
/** Visible rows are batched for this long before a lookup goes out. */
const BATCH_MS = 300;
/** Rows found but no address read for this long: the adapter no longer fits the page. */
const PAUSE_AFTER_MS = 10_000;
/** The board's column boxes are looked for again after this long, while the safety option is on. */
const COLUMNS_MS = 2_000;
/** A coin's map totals are asked for again after this long (the worker keeps them a minute too). */
const TOTALS_MS = 60_000;

export interface EngineDeps {
  lookup(mints: string[]): Promise<LookupAnswer>;
  report(health: { rows: number; mints: number; paused: boolean }): void;
  /** A tracked coin's bubble map totals, for the tooltip; null when there are none or the read failed. */
  totals?(mint: string): Promise<OverlayBubbleTotals | null>;
  /** The safety verdicts of coins on screen, while the hide-or-mark option is on. */
  safety?(mints: string[]): Promise<SafetyAnswer>;
}

interface RowState {
  mint: string | null;
  decoration: Decoration | null;
  /** The X over a coin failing the safety screen, in "mark" mode. */
  mark: SafetyMark | null;
  /** The row is hidden for failing it, in "hide" mode. */
  hidden: boolean;
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
  private columns: { at: number; boxes: [Element, BoardColumn][] } = { at: 0, boxes: [] };
  private tipPrefs: TooltipPrefs = DEFAULT_TOOLTIP;
  private mutation: MutationObserver | null = null;
  private intersection: IntersectionObserver | null = null;
  private frame = 0;
  private batchTimer: number | undefined;
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
    cancelAnimationFrame(this.frame);
    for (const [row, state] of this.rows) {
      state.decoration?.remove();
      this.clearSafety(row, state);
    }
    this.rows.clear();
    this.visible.clear();
    this.tooltip.hideNow();
  }

  applySettings(settings: OverlaySettings): void {
    this.settings = settings;
    for (const [row, state] of this.rows) this.draw(row, state);
  }

  applyTooltip(prefs: TooltipPrefs): void {
    const asked = prefs.safety.mode !== "off" && this.tipPrefs.safety.mode === "off";
    this.tipPrefs = prefs;
    for (const [row, state] of this.rows) this.draw(row, state);
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
    const token = this.tokens.get(mint)?.token;
    if (!token) return;
    const draw = () => {
      const live = this.tokens.get(mint)?.token ?? token;
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
        state = { mint: null, decoration: null, mark: null, hidden: false };
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

  private queueLookup(force = false): void {
    window.clearTimeout(this.batchTimer);
    this.batchTimer = window.setTimeout(() => void this.lookupVisible(force), BATCH_MS);
  }

  private async lookupVisible(force: boolean): Promise<void> {
    if (this.paused) return;
    const now = Date.now();
    const wanted = new Set<string>();
    const unsafe = new Set<string>();
    const screening = this.screening();
    for (const [row, state] of this.rows) {
      const mint = state.mint;
      // A hidden row is never on screen, so it is asked about while hidden, to show it once it passes.
      if (!mint || !(this.visible.has(row) || state.hidden)) continue;
      const known = this.tokens.get(mint);
      if (this.visible.has(row) && (force || !known || now - known.at >= REFRESH_MS)) wanted.add(mint);
      const verdict = this.safety.get(mint);
      if (screening && (force || !verdict || now - verdict.at >= REFRESH_MS)) unsafe.add(mint);
    }
    await Promise.all([
      wanted.size > 0 &&
        this.deps.lookup([...wanted].slice(0, 100)).then((answer) => {
          if (!answer.problem) this.receive([...wanted], answer, now);
        }),
      unsafe.size > 0 && this.deps.safety && this.readSafety([...unsafe].slice(0, 100), now),
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

  private async readSafety(mints: string[], now: number): Promise<void> {
    const answer = await this.deps.safety!(mints);
    if (answer.problem) return;
    this.receiveSafety(mints, answer, now);
  }

  /** Exposed for tests. A coin left out of the answer was never screened, so it is shown. */
  receiveSafety(asked: string[], answer: SafetyAnswer, now = Date.now()): void {
    for (const mint of asked) this.safety.set(mint, { at: now, verdict: answer.verdicts[mint] ?? null });
    if (this.safety.size > 5_000) {
      for (const [mint, v] of this.safety) if (now - v.at > 10 * REFRESH_MS) this.safety.delete(mint);
    }
    for (const [row, state] of this.rows) if (state.mint && asked.includes(state.mint)) this.draw(row, state);
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
      // Set again on each draw: the site's renderer may rewrite the row's style.
      if (row.style.getPropertyValue("display") !== "none")
        row.style.setProperty("display", "none", "important");
      state.hidden = true;
      return;
    }
    this.showRow(row, state);
    if (failed && mode === "mark") {
      state.mark ??= new SafetyMark(row);
      state.mark.update(verdict.reasons, colorsOf(this.tipPrefs));
    } else {
      state.mark?.remove();
      state.mark = null;
    }
  }

  private showRow(row: HTMLElement, state: RowState): void {
    if (!state.hidden) return;
    if (row.style.getPropertyPriority("display") === "important") row.style.removeProperty("display");
    state.hidden = false;
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
    const token = state.mint ? this.tokens.get(state.mint)?.token : null;
    if (!token || this.paused) {
      state.decoration?.remove();
      return;
    }
    const verdict = verdictFor(token, this.settings);
    if (!verdict.ring) {
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
      main: pillSegments(main, token, verdict, this.settings, totals),
      more: more && pillSegments(more, token, verdict, this.settings, totals),
      riskDot: this.tipPrefs.riskDot,
      colors: look.colors,
      effect: look.effect,
    });
  }
}
