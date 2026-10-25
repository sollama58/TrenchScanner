import type { SiteAdapter } from "./adapters/adapter";
import { Decoration, Tooltip, tooltipBody } from "./ui";
import { DEFAULT_TOOLTIP, needsMap, shownLines, type TooltipPrefs } from "../shared/tooltip";
import type { LookupAnswer, OverlayBubbleTotals, OverlaySettings, OverlayToken } from "../shared/types";
import { verdictFor } from "../shared/verdict";

/** How long the rows on screen go before they are asked about again (new alerts land this way). */
const REFRESH_MS = 15_000;
/** Visible rows are batched for this long before a lookup goes out. */
const BATCH_MS = 300;
/** Rows found but no address read for this long: the adapter no longer fits the page. */
const PAUSE_AFTER_MS = 10_000;
/** A coin's map totals are asked for again after this long (the worker keeps them a minute too). */
const TOTALS_MS = 60_000;

export interface EngineDeps {
  lookup(mints: string[]): Promise<LookupAnswer>;
  report(health: { rows: number; mints: number; paused: boolean }): void;
  /** A tracked coin's bubble map totals, for the tooltip; null when there are none or the read failed. */
  totals?(mint: string): Promise<OverlayBubbleTotals | null>;
}

interface RowState {
  mint: string | null;
  decoration: Decoration | null;
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
    for (const state of this.rows.values()) state.decoration?.remove();
    this.rows.clear();
    this.visible.clear();
    this.tooltip.hideNow();
  }

  applySettings(settings: OverlaySettings): void {
    this.settings = settings;
    for (const [row, state] of this.rows) this.draw(row, state);
  }

  applyTooltip(prefs: TooltipPrefs): void {
    this.tipPrefs = prefs;
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
      );
    };
    draw();
    const cached = this.totals.get(mint);
    if (!this.deps.totals || !needsMap(this.tipPrefs, this.settings)) return;
    if (cached && Date.now() - cached.at < TOTALS_MS) return;
    void this.deps.totals(mint).then((totals) => {
      this.totals.set(mint, { at: Date.now(), totals });
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
        this.intersection?.unobserve(row);
        this.visible.delete(row);
        this.rows.delete(row);
      }
    }
    let withMint = 0;
    for (const row of found) {
      const mint = this.adapter.mintOf(row);
      if (mint) withMint++;
      let state = this.rows.get(row);
      if (!state) {
        state = { mint: null, decoration: null };
        this.rows.set(row, state);
        this.intersection?.observe(row);
      }
      // A recycled row now shows another token: drop what was drawn for the last one.
      if (state.mint !== mint) {
        state.decoration?.remove();
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
        for (const state of this.rows.values()) state.decoration?.remove();
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
    for (const row of this.visible) {
      const mint = this.rows.get(row)?.mint;
      if (!mint) continue;
      const known = this.tokens.get(mint);
      if (force || !known || now - known.at >= REFRESH_MS) wanted.add(mint);
    }
    if (wanted.size === 0) return;
    const answer = await this.deps.lookup([...wanted].slice(0, 100));
    if (answer.problem) return;
    this.receive([...wanted], answer, now);
  }

  /** Exposed for tests. */
  receive(asked: string[], answer: LookupAnswer, now = Date.now()): void {
    for (const mint of asked) this.tokens.set(mint, { at: now, token: answer.tokens[mint] ?? null });
    for (const [row, state] of this.rows) if (state.mint && asked.includes(state.mint)) this.draw(row, state);
  }

  private draw(row: HTMLElement, state: RowState): void {
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
    state.decoration.update(verdict, this.settings.style.ring, this.settings.style.calmMotion);
  }
}
