import { SectionBoundary } from "./SectionBoundary";
import { ScopeRowSkeletons } from "./Skeleton";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Card, CuratedPage, Filter, LaunchPage, Leaderboard, MatchPage } from "../api";
import {
  passesColumnFilter,
  withinMaxAge,
  useScopeSettings,
  activeFilterCount,
  type ScopeDisplay,
} from "../scopeSettings";
import { rowChips } from "../scopeChips";
import { openCustomize } from "../customize";
import {
  usePolling,
  usePollingAll,
  useLiveMarketCaps,
  useMediaQuery,
  useNow,
  useNudgeStream,
} from "../hooks";
import { joinPages } from "../feedFill";
import { change, pct, tokenLabel, usd } from "../format";
import { cardOutcome, outcomeBadge } from "../outcome";
import { QUICK_LINK_SITES, useAppearance } from "../appearance";
import { tileLook, tileMode, type TileMode } from "../tileTone";
import { openTokenModal } from "../tokenModal";
import {
  columnLabel,
  emptyColumns,
  frameOf,
  holdFrame,
  kindDef,
  SCOPE_MODEL_PAGES,
  SCOPE_PAGES,
  SCOPE_STREAM_PAGES,
  scopeTickIds,
  shortAge,
  splitScope,
  swipeStep,
  type ScopeColumn,
  type ScopeColumnKind,
  type ScopeColumns,
  type ScopeFrame,
  type ScopeHold,
} from "../scope";
import {
  FeeBadge,
  LINKS,
  nowReading,
  nowReadingAge,
  QuoteBadge,
  QuotePill,
  recordedPeakOf,
} from "./AlertCard";
import { CardSearchButton } from "./CardSearchButton";
import { WatchStar } from "./WatchStar";
import { DexInfoLabel, dexInfoLabel } from "../dexInfoLabel";
import { QuickBuyPill } from "./QuickBuyPill";
import { TokenImage } from "./TokenImage";
import { FilterGlyph } from "./FilterBadge";
import { BrainIcon, EyeOffIcon, FunnelIcon, SlidersIcon } from "./Icons";
import { dueToUnhide, hideToken, unhideTokens, useHiddenTokenIds, useHiddenTokens } from "../hiddenTokens";
import { SocialLinks, socialLinks } from "./SocialLinks";

/** After a finger lifts, the board stays still this long, so a tap lands on the row it aimed at. */
const TOUCH_HOLD_MS = 1_000;

/** A list scrolled down this far holds the board still. */
const SCROLL_HOLD_PX = 48;

/** Scope's phone layout: one column at a time under tabs (styles.css's 899px breakpoint). */
const PHONE_QUERY = "(max-width: 899px)";

/** Clicks on these inside a row do their own thing rather than open the token modal. */
const OWN_CLICK = "a, button, input, select, textarea, label, summary, [role='button']";

/** The graduated column's list: the Stream's graduated tokens, polled as often as the Stream. */
const GRADUATED_PATH = "/launches?graduated=1";
const GRADUATED_POLL_MS = 10_000;

/** No held coins: one set, so the board's memos keep. */
const NO_TOKENS: ReadonlySet<string> = new Set();

/** The Stream (GET /launches): Scope's New and About to graduate when its Stream switch is on. */
const STREAM_PATH = "/launches";

/**
 * Scope (user ask 2026-10-18): the Live feed's alerts as a dense three-column board of compact
 * rows - your filters' alerts, the models' calls, and every graduated token that passes the
 * safety screen - with its own settings (scopeSettings.ts: each column's filters and how the rows
 * look, apart from the Cards view's Customize) and the Live feed's token window. The board
 * holds still while a mouse rests on it or a list is scrolled down; new alerts wait behind a "N new"
 * pill. On phones one column shows at a time under sticky tabs: tap a tab or swipe sideways.
 */
export function ScopeBoard({
  feedPath,
  modelsOn,
  heldTokenIds = NO_TOKENS,
  onStatus,
}: {
  /** The Live feed's page `n`, so Scope reads exactly what the cards view does. */
  feedPath: (n: number) => string;
  modelsOn: boolean;
  /**
   * Pro: coins the wallet holds (heldTokens.ts), which skip hiding and the columns' filters but
   * "older than", and keep the column and place they'd have anyway.
   */
  heldTokenIds?: ReadonlySet<string>;
  /**
   * Whether the board is held still and whether its feed reads are failing, for the Live header's
   * Scanning pill, which says Live / Paused for Scope (user ask 2026-10-23).
   */
  onStatus?: (status: { paused: boolean; failing: boolean }) => void;
}) {
  // Rows say their age in seconds at first, so the board ticks faster than the cards view.
  const now = useNow(5_000);
  const look = useAppearance();
  const settings = useScopeSettings();
  const display = settings.display;
  const first = usePolling<MatchPage>(feedPath(1), 30_000);
  const morePaths = Array.from({ length: SCOPE_PAGES - 1 }, (_, i) => feedPath(i + 2));
  const more = usePollingAll<MatchPage>(morePaths, 30_000);
  const nudged = () => first.reload();
  useNudgeStream("/curated/stream", nudged, modelsOn);
  useNudgeStream("/matches/stream", nudged);
  const board = settings.board;
  const has = (...kinds: ScopeColumnKind[]) => board.some((c) => kinds.includes(c.kind));
  // Each source is read only while a column shows it: the graduated list for Graduated, the
  // Stream's newest pages for New and About to graduate, and each picked model's own calls.
  const graduated = usePollingAll<LaunchPage>(has("graduated") ? [GRADUATED_PATH] : [], GRADUATED_POLL_MS);
  const gradPage = graduated.data[0] ?? null;
  const streamOn = has("new", "soon");
  const streamPaths = streamOn
    ? Array.from({ length: SCOPE_STREAM_PAGES }, (_, i) =>
        i === 0 ? STREAM_PATH : `${STREAM_PATH}?page=${i + 1}`,
      )
    : [];
  const streamPages = usePollingAll<LaunchPage>(streamPaths, GRADUATED_POLL_MS);
  const pickedModels = useMemo(
    () => [...new Set(board.filter((c) => c.kind === "model").flatMap((c) => c.picks))],
    [board],
  );
  const modelPaths = pickedModels.flatMap((id) =>
    Array.from(
      { length: SCOPE_MODEL_PAGES },
      (_, i) => `/curated?model=${encodeURIComponent(id)}${i > 0 ? `&page=${i + 1}` : ""}`,
    ),
  );
  const modelPages = usePollingAll<CuratedPage>(modelPaths, 30_000);
  // Names for the columns' titles and the settings' pick lists: your saved filters and every model.
  const savedFilters = usePollingAll<Filter[]>(has("filter") ? ["/filters"] : [], 120_000);
  const leaderboard = usePollingAll<Leaderboard>(has("model") ? ["/curated/models?days=30"] : [], 120_000);
  // Each column fills in as its own source answers: none waits on the others (user ask 2026-10-18).
  const streamFirst = streamPages.data[0];
  // One list for the live tick, in runs: the feed, graduated, the Stream, then each model's calls.
  const sources = useMemo(() => {
    if (!first.data && !gradPage && !streamFirst && !modelPages.data.some(Boolean)) return undefined;
    const grad = gradPage?.launches ?? [];
    const gradIds = new Set(grad.map((c) => c.id));
    const stream: Card[] = [];
    // A page still loading ends the run, as on the feed.
    for (const p of streamPages.data) {
      if (!p) break;
      for (const c of p.launches) if (!gradIds.has(c.id)) stream.push(c);
    }
    const feed = first.data ? joinPages([first.data, ...more.data]) : [];
    const runs: [string, number][] = [
      ["feed", feed.length],
      ["graduated", grad.length],
      ["stream", stream.length],
    ];
    const cards = [...feed, ...grad, ...stream];
    pickedModels.forEach((id, m) => {
      const pages = modelPages.data.slice(m * SCOPE_MODEL_PAGES, (m + 1) * SCOPE_MODEL_PAGES);
      const calls = pages.flatMap((p) => p?.alerts ?? []);
      runs.push([`model:${id}`, calls.length]);
      cards.push(...calls);
    });
    return { cards, runs };
  }, [first.data, more.data, gradPage, streamPages.data, streamFirst, modelPages.data, pickedModels]);
  const [tickIds, setTickIds] = useState<string[] | undefined>(undefined);
  const visible = useLiveMarketCaps(sources?.cards, tickIds);
  /** The ticked cards cut back into their runs (the tick keeps every card in place). */
  const runs = useMemo(() => {
    const out = new Map<string, Card[]>();
    if (!visible || !sources) return out;
    let at = 0;
    for (const [name, n] of sources.runs) {
      out.set(name, visible.slice(at, at + n));
      at += n;
    }
    return out;
  }, [visible, sources]);

  const gradTokens = useMemo(() => new Set((gradPage?.launches ?? []).map((c) => c.tokenId)), [gradPage]);
  // Tokens the user hid (user ask 2026-10-19) are off every column. With auto-unhide on, one that
  // graduated or reached a new 2x, 4x or 10x comes back.
  const hiddenTokens = useHiddenTokens();
  const hiddenIds = useHiddenTokenIds();
  useEffect(() => {
    if (visible) unhideTokens(dueToUnhide(hiddenTokens, visible, gradTokens));
  }, [visible, hiddenTokens, gradTokens]);
  const onHide = useCallback(
    (card: Card) => hideToken(card, visible ?? [], gradTokens),
    [visible, gradTokens],
  );
  // Every column before its filters: what the settings window offers to pick from.
  const unfiltered = useMemo(() => {
    if (!visible) return undefined;
    const run = (name: string) => {
      const cards = runs.get(name) ?? [];
      return hiddenIds.size > 0
        ? cards.filter((c) => !hiddenIds.has(c.tokenId) || heldTokenIds.has(c.tokenId))
        : cards;
    };
    const modelCalls = new Map(pickedModels.map((id) => [id, run(`model:${id}`)]));
    return splitScope(
      board.map((c) => ({ ...c, keepGraduated: c.filter.showGraduated })),
      { feed: run("feed"), graduated: run("graduated"), stream: run("stream"), modelCalls },
    );
  }, [visible, runs, hiddenIds, heldTokenIds, board, pickedModels]);
  // Each column through its own filters (Scope's settings, not Customize's).
  const fresh = useMemo(() => {
    if (!unfiltered) return undefined;
    const out: ScopeColumns = { ...unfiltered };
    for (const col of board) {
      const f = col.filter;
      const rows = unfiltered[col.id] ?? [];
      out[col.id] =
        activeFilterCount(f) > 0
          ? rows.filter((c) =>
              heldTokenIds.has(c.tokenId) ? withinMaxAge(c, f, now) : passesColumnFilter(c, f, col.kind, now),
            )
          : rows;
    }
    return out;
  }, [unfiltered, board, now, heldTokenIds]);
  // Names by id: filters from your saved list and the feed's alerts, models from the leaderboard
  // and the calls on the board.
  const names = useMemo(() => {
    const out = new Map<string, string>();
    for (const c of visible ?? []) {
      if (c.filter) out.set(c.filter.id, c.filter.name);
      if (c.curated?.model && c.curated.modelName) out.set(c.curated.model, c.curated.modelName);
    }
    for (const f of savedFilters.data[0] ?? []) out.set(f.id, f.name);
    for (const e of leaderboard.data[0]?.entries ?? []) out.set(e.id, e.name);
    return out;
  }, [visible, savedFilters.data, leaderboard.data]);
  const shownCols = useMemo(
    () =>
      board.map((c) => {
        const def = kindDef(c.kind);
        const label = columnLabel(c, names);
        return { ...c, label, short: def.picks ? label : def.short, hint: def.hint };
      }),
    [board, names],
  );

  // Holding still: the frame drawn when the board paused, refreshed in place.
  const [frame, setFrame] = useState<ScopeFrame | null>(null);
  const lastCards = useRef(new Map<string, Card>());
  useEffect(() => {
    for (const c of visible ?? []) lastCards.current.set(c.id, c);
  }, [visible]);
  const held = useMemo(
    () => (fresh && frame ? holdFrame(frame, fresh, lastCards.current) : null),
    [fresh, frame],
  );
  const heldCols: ScopeColumns = held?.cols ?? fresh ?? emptyColumns(board);
  // A held board keeps its rows, but not one just hidden.
  let cols = heldCols;
  if (held && hiddenIds.size > 0) {
    cols = {};
    for (const [id, rows] of Object.entries(heldCols))
      cols[id] = rows.filter((c) => !hiddenIds.has(c.tokenId) || heldTokenIds.has(c.tokenId));
  }
  const rowsOf = (id: ScopeColumn): Card[] => cols[id] ?? [];
  // Columns whose source hasn't answered yet show placeholder rows, not "nothing here".
  const modelsLoading = !modelPages.data.some(Boolean) && !modelPages.error;
  const loading = (kind: ScopeColumnKind) =>
    kind === "graduated"
      ? !gradPage && !graduated.error
      : kind === "new" || kind === "soon"
        ? !streamFirst && !streamPages.error
        : kind === "model"
          ? modelsLoading
          : !first.data && !first.error;
  const pending = held?.pending ?? 0;

  const tickKey = scopeTickIds(cols).join(",");
  useEffect(() => setTickIds(tickKey ? tickKey.split(",") : undefined), [tickKey]);

  const freshRef = useRef(fresh);
  freshRef.current = fresh;
  const phone = useMediaQuery(PHONE_QUERY);
  // Why the board holds still. A finger on it only guards a tap for a moment and says nothing:
  // on phones every scroll is a touch, so a touch saying "Paused" read as paused all the time
  // (user report 2026-10-19). A mouse resting on it, or a list scrolled down, does say so.
  const [holdsBy, setHoldsBy] = useState<ReadonlySet<ScopeHold>>(() => new Set());
  const setHold = useCallback((why: ScopeHold, on: boolean) => {
    setHoldsBy((s) => {
      if (s.has(why) === on) return s;
      const next = new Set(s);
      if (on) next.add(why);
      else next.delete(why);
      return next;
    });
  }, []);
  const touchTimer = useRef<number | undefined>(undefined);
  const holds = display.pauseOnHover;
  useEffect(() => {
    if (!holds || holdsBy.size === 0) setFrame(null);
    else setFrame((f) => f ?? (freshRef.current ? frameOf(freshRef.current) : null));
  }, [holds, holdsBy]);
  // A board with other columns starts live.
  const boardKey = board.map((c) => `${c.id}:${c.kind}:${c.picks.join("+")}`).join(",");
  useEffect(() => setFrame(null), [boardKey]);
  const touchStart = () => {
    window.clearTimeout(touchTimer.current);
    setHold("touch", true);
  };
  const touchEnd = () => {
    window.clearTimeout(touchTimer.current);
    touchTimer.current = window.setTimeout(() => setHold("touch", false), TOUCH_HOLD_MS);
  };
  useEffect(() => () => window.clearTimeout(touchTimer.current), []);
  const paused = frame !== null && (holdsBy.has("pointer") || holdsBy.has("scroll"));
  const failing = !!first.error;
  useEffect(() => onStatus?.({ paused, failing }), [onStatus, paused, failing]);
  // New filters show at once, even on a held board: it holds still from the filtered rows.
  const columnFilters = board.map((c) => JSON.stringify(c.filter)).join("|");
  useEffect(() => {
    setFrame((f) => (f && freshRef.current ? frameOf(freshRef.current) : f));
  }, [columnFilters]);

  // Wide screens: a mouse holds the board only while it reads a column: over its header or rows,
  // not its scrollbar, the gap between columns or the sideways scrollbar (user ask 2026-10-23).
  const onColPointer = (e: React.PointerEvent<HTMLElement>) => {
    if (e.pointerType !== "mouse") return;
    const rows = e.currentTarget.querySelector<HTMLElement>(".scope-rows");
    let inside = true;
    if (rows) {
      const r = rows.getBoundingClientRect();
      const x = e.clientX - r.left - rows.clientLeft;
      const y = e.clientY - r.top - rows.clientTop;
      const onRows = x >= 0 && y >= 0 && e.clientX <= r.right && e.clientY <= r.bottom;
      inside = !onRows || (x < rows.clientWidth && y < rows.clientHeight);
    }
    setHold("pointer", inside);
  };
  // Wide screens: a column scrolled down holds the board.
  const scrolledCols = useRef(new Set<ScopeColumn>());
  const onColScroll = (id: ScopeColumn, top: number) => {
    if (phone) return;
    if (top > SCROLL_HOLD_PX) scrolledCols.current.add(id);
    else scrolledCols.current.delete(id);
    setHold("scroll", scrolledCols.current.size > 0);
  };
  // Phones: the page scrolls the rows under a bar that sticks below the top bar. Scrolled into the
  // list, the board holds still; back at its top, it is live again.
  const root = useRef<HTMLDivElement>(null);
  const bleed = useWideBleed(root, !phone && board.length > WIDE_FROM_COLS);
  const bar = useRef<HTMLDivElement>(null);
  const strip = useRef<HTMLDivElement>(null);
  const scrolledInto = useCallback(() => {
    const b = bar.current?.getBoundingClientRect();
    const s = strip.current?.getBoundingClientRect();
    return !!b && !!s && s.top < b.bottom - SCROLL_HOLD_PX;
  }, []);
  useEffect(() => {
    if (!phone) return;
    scrolledCols.current.clear();
    let raf = 0;
    const check = () => {
      raf = 0;
      setHold("scroll", scrolledInto());
    };
    const onScroll = () => {
      if (!raf) raf = window.requestAnimationFrame(check);
    };
    check();
    window.addEventListener("scroll", onScroll, { passive: true });
    // The bar sticks just under the app's top bar, whatever its height.
    const top = document.querySelector<HTMLElement>(".topbar");
    const el = root.current;
    const fit = () => el?.style.setProperty("--scope-sticky-top", `${top ? top.offsetHeight : 0}px`);
    fit();
    const ro = top && typeof ResizeObserver === "function" ? new ResizeObserver(fit) : null;
    if (top) ro?.observe(top);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.cancelAnimationFrame(raf);
      ro?.disconnect();
      setHold("scroll", false);
    };
  }, [phone, scrolledInto, setHold]);
  /** Phones: back to the board's top, where it is live. */
  const toBoardTop = () => {
    const b = bar.current?.getBoundingClientRect();
    const s = strip.current?.getBoundingClientRect();
    if (!b || !s || s.top >= b.bottom) return;
    window.scrollTo({ top: window.scrollY + s.top - b.bottom - 8, behavior: "smooth" });
  };
  // "N new": show them now, and keep holding still if the pointer is still on the board.
  const showNew = () => {
    if (!fresh) return;
    setFrame((f) => (f ? frameOf(fresh) : null));
    if (phone) toBoardTop();
  };

  // Phones: one column at a time, picked by the tabs or a sideways swipe.
  const [active, setActive] = useState<ScopeColumn>(() => board[0]?.id ?? "");
  const swipeFrom = useRef<{ x: number; y: number } | null>(null);
  const goToColumn = (id: ScopeColumn) => {
    if (id === activeCol) return;
    setActive(id);
    if (phone && scrolledInto()) toBoardTop();
  };
  const onSwipeStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    swipeFrom.current = e.touches.length === 1 && t ? { x: t.clientX, y: t.clientY } : null;
  };
  const onSwipeEnd = (e: React.TouchEvent) => {
    const from = swipeFrom.current;
    const t = e.changedTouches[0];
    swipeFrom.current = null;
    if (!phone || !from || !t) return;
    const step = swipeStep(t.clientX - from.x, t.clientY - from.y);
    const i = shownCols.findIndex((c) => c.id === activeCol) + step;
    const next = shownCols[i];
    if (step !== 0 && next) goToColumn(next.id);
  };

  // A hidden column can't stay the phone's active tab.
  const activeCol = shownCols.some((c) => c.id === active) ? active : (shownCols[0]?.id ?? "");
  const filterButton = (id: ScopeColumn, label: string) => {
    const f = board.find((c) => c.id === id)?.filter;
    const count = f ? activeFilterCount(f) : 0;
    return (
      <button
        type="button"
        className={`ghost icon-btn scope-filter-btn${count > 0 ? " on" : ""}`}
        onClick={() => openCustomize("scope-columns", { column: id })}
        title={`Filter what shows in ${label}${count > 0 ? ` (${count} on)` : ""}`}
        aria-label={`Filter ${label}${count > 0 ? `, ${count} filters on` : ""}`}
      >
        <FunnelIcon size={14} />
        {count > 0 && <span className="scope-filter-count num">{count}</span>}
      </button>
    );
  };
  const tiles = tileMode(look);

  if (first.error && !first.data && !gradPage && !streamFirst)
    return <p className="error">Couldn&apos;t load your feed: {first.error.message}</p>;

  return (
    <div
      ref={root}
      className={`scope${paused ? " held" : ""}${first.stale ? " stale" : ""}${bleed > 0 ? " wide" : ""} ${scopeLookClass(display)}`}
      style={{ "--scope-cols": shownCols.length } as React.CSSProperties}
      onTouchStart={touchStart}
      onTouchEnd={touchEnd}
      onTouchCancel={touchEnd}
    >
      <div
        className={`scope-bar${paused && pending > 0 ? "" : " quiet"}`}
        ref={bar}
        onPointerEnter={(e) => e.pointerType === "mouse" && paused && setHold("pointer", true)}
        onPointerLeave={(e) => e.pointerType === "mouse" && setHold("pointer", false)}
      >
        <div className="segmented small scope-tabs" role="tablist" aria-label="Scope columns">
          {shownCols.map((c) => (
            <button
              key={c.id}
              type="button"
              role="tab"
              aria-selected={activeCol === c.id}
              className={activeCol === c.id ? "on" : ""}
              onClick={() => goToColumn(c.id)}
            >
              {c.short} <span className="num muted">{rowsOf(c.id).length}</span>
            </button>
          ))}
        </div>
        <span className="scope-bar-filter">
          {filterButton(activeCol, shownCols.find((c) => c.id === activeCol)?.label ?? "")}
        </span>
        {paused && pending > 0 && (
          <button
            type="button"
            className="scope-new"
            onClick={showNew}
            title={phone ? "Show the new rows and go back to the top" : "Show the new rows"}
          >
            {phone && <span aria-hidden="true">↑ </span>}
            {pending} new
          </button>
        )}
      </div>
      <div
        className="scope-strip"
        ref={strip}
        onTouchStart={onSwipeStart}
        onTouchEnd={onSwipeEnd}
        onTouchCancel={() => (swipeFrom.current = null)}
      >
        {shownCols.map((c) => (
          <section
            key={c.id}
            className={`scope-col scope-col-${c.kind}${activeCol === c.id ? " active" : ""}`}
            aria-label={c.label}
            onPointerEnter={onColPointer}
            onPointerMove={onColPointer}
            onPointerLeave={(e) => e.pointerType === "mouse" && setHold("pointer", false)}
          >
            <header className="scope-col-head">
              <h3 title={c.hint}>{c.label}</h3>
              <span className="num muted">{rowsOf(c.id).length}</span>
              {filterButton(c.id, c.label)}
            </header>
            <div className="scope-rows" onScroll={(e) => onColScroll(c.id, e.currentTarget.scrollTop)}>
              {kindDef(c.kind).picks && c.picks.length === 0 ? (
                <div className="scope-empty scope-empty-pick">
                  <p className="muted small">
                    Pick up to three {c.kind === "filter" ? "of your filters" : "models"} for this column.
                  </p>
                  <button
                    type="button"
                    className="ghost small-btn"
                    onClick={() => openCustomize("scope-columns")}
                  >
                    Choose {c.kind === "filter" ? "filters" : "models"}
                  </button>
                </div>
              ) : rowsOf(c.id).length === 0 && loading(c.kind) ? (
                <ScopeRowSkeletons />
              ) : rowsOf(c.id).length === 0 ? (
                <p className="muted small scope-empty">
                  {(unfiltered?.[c.id]?.length ?? 0) > 0
                    ? "Nothing here passes this column's filters right now."
                    : emptyText(
                        c.kind,
                        modelsOn,
                        graduated.error,
                        streamPages.error,
                        modelPages.error,
                        first.error,
                      )}
                </p>
              ) : (
                rowsOf(c.id).map((card, i) => (
                  <SectionBoundary key={card.id} label="This row" size="card" resetKey={card}>
                    <ScopeRow
                      index={i}
                      card={card}
                      now={now}
                      display={display}
                      tiles={tiles}
                      marker={c.kind === "graduated" || c.kind === "model"}
                      onHide={onHide}
                    />
                  </SectionBoundary>
                ))
              )}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

/** Past this many columns, the board widens past the page's width into the window's (user ask 2026-10-23). */
const WIDE_FROM_COLS = 3;
/** Room kept clear at each side of the window: the Trades and Utility drawer handles sit on the right. */
const WIDE_GUTTER_PX = 56;

/**
 * How far the Live feed's panel may reach past each side of the page's column into the window, so
 * four to six columns sit side by side without a sideways scroll: the window's spare width beyond
 * the column at the narrower side, less a gutter, measured on resize. The panel (LiveTab's
 * `.panel.feed`) gets it as negative side margins while the board is wide, and loses them after.
 */
function useWideBleed(root: React.RefObject<HTMLDivElement | null>, on: boolean): number {
  const [bleed, setBleed] = useState(0);
  useLayoutEffect(() => {
    const panel = root.current?.closest<HTMLElement>(".panel");
    const column = panel?.parentElement;
    if (!on || !panel || !column) {
      setBleed(0);
      return;
    }
    const fit = () => {
      const page = document.documentElement.clientWidth;
      const box = column.getBoundingClientRect();
      const side = Math.max(0, Math.floor(Math.min(box.left, page - box.right) - WIDE_GUTTER_PX));
      panel.style.marginInline = side > 0 ? `${-side}px` : "";
      setBleed(side);
    };
    fit();
    window.addEventListener("resize", fit);
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(fit) : null;
    ro?.observe(column);
    return () => {
      window.removeEventListener("resize", fit);
      ro?.disconnect();
      panel.style.marginInline = "";
    };
  }, [root, on]);
  return bleed;
}

function emptyText(
  col: ScopeColumnKind,
  modelsOn: boolean,
  gradError: Error | null,
  streamError: Error | null,
  modelError: Error | null,
  feedError: Error | null,
): string {
  if (col === "model")
    return modelError
      ? `Couldn't load these models' calls: ${modelError.message}`
      : "No calls from these models lately.";
  if (col === "filter")
    return feedError
      ? `Couldn't load your feed: ${feedError.message}`
      : "Nothing from these filters among the newest alerts.";
  if ((col === "filters" || col === "models") && feedError)
    return `Couldn't load your feed: ${feedError.message}`;
  if ((col === "new" || col === "soon") && streamError)
    return `Couldn't load the Stream: ${streamError.message}`;
  if (col === "new") return "Nothing has passed the safety screen in the band lately.";
  if (col === "soon") return "Nothing on the Stream is still on its curve lately.";
  if (col === "filters") return "Nothing from your filters among the newest alerts.";
  if (col === "models")
    return modelsOn ? "No model calls among the newest alerts." : "Model alerts are off in Settings.";
  return gradError
    ? `Couldn't load graduated tokens: ${gradError.message}`
    : "No graduated token has passed the safety screen in the last day.";
}

/** The board's look as classes: Scope settings' density, layout, sizes and chip style. */
export function scopeLookClass(d: ScopeDisplay): string {
  return [
    `scope-d-${d.density}`,
    `scope-l-${d.layout}`,
    `scope-img-${d.imageSize}`,
    `scope-text-${d.textSize}`,
    `scope-chips-${d.chipStyle}`,
    d.colorMcap ? "" : "scope-mc-plain",
  ]
    .filter(Boolean)
    .join(" ");
}

/** One alert as a row: avatar, ticker and age, where it came from, the figures, and data chips. */
export function ScopeRow({
  card,
  now,
  display: d,
  tiles,
  preview = false,
  marker = false,
  index = 0,
  onHide,
}: {
  card: Card;
  now: number;
  display: ScopeDisplay;
  tiles: TileMode;
  /** The settings window's example row: no token window, no quick buy. */
  preview?: boolean;
  /** Show where an alert came from whatever the settings say: the Graduated column's alerts. */
  marker?: boolean;
  /** Its place in the column: a column's first rows fade in one after another as they land. */
  index?: number;
  /** Hides the row's token from Cards and Scope (user ask 2026-10-19); no button without it. */
  onHide?: (card: Card) => void;
}) {
  const open = () => {
    if (!preview) openTokenModal(card, now);
  };
  const [copied, setCopied] = useState(false);
  const copyCa = () => {
    void navigator.clipboard?.writeText(card.token.mintAddress).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  };
  const onClick = (e: React.MouseEvent) => {
    if (e.defaultPrevented || e.button !== 0) return;
    if ((e.target as Element).closest?.(OWN_CLICK)) return;
    open();
  };
  const curated = card.curated;
  const calls = curated?.calledBy ?? [];
  const filter = card.kind === "match" ? card.filter : null;
  const outcome = cardOutcome(card, now);
  const badge = outcomeBadge(outcome);
  // As on the card: a mark once a target hit or the window closed (✓ 2x, ✓✓ 4x, ✓✓✓ 10x, ↗ ran
  // later, ⊘ stopped out, ✕ missed), nothing while grading. Its words stay in the tooltip.
  const graded = outcome !== null && !(outcome.status === "watching" && !outcome.hit2x);
  const mark = graded && badge.tone !== "neutral" ? badge.text.split(" ")[0] : null;
  // Green for a win, red for a miss, muted for a stop-out or a late run (user ask 2026-10-23).
  const markTone = mark === "⊘" || badge.tone === "info" ? "muted" : badge.tone;
  const alertMcap = card.snapshot.marketCapUsd;
  const nowMcap = nowReading(card);
  const move = change(alertMcap, nowMcap);
  // As on the card: how old "now" is once that matters, and the alert's figure named as such when
  // there is no reading after the call yet.
  const nowAge = nowReadingAge(card, nowMcap, now);
  const nowTitle =
    nowMcap === null
      ? "Market cap at the alert: no reading since yet"
      : nowAge !== null
        ? `Market cap now, read ${nowAge} ago`
        : "Market cap now";
  const { pct: recorded } = recordedPeakOf(card);
  const peak = move !== null && move > 0 ? Math.max(recorded ?? 0, move) : recorded;
  const alertedAt = curated?.alertedAt ?? card.matchedAt;
  const ageMs = now - Date.parse(card.kind === "match" ? card.matchedAt : alertedAt);
  const socials = d.showSocials ? socialLinks(card.token) : [];
  const { quickLinks } = useAppearance();
  const tradeLinks = d.showTradeLinks
    ? [...QUICK_LINK_SITES.filter((l) => quickLinks.includes(l.id)), ...LINKS]
    : [];
  const label = tokenLabel(card.token);
  const high = calls.some((c) => c.tier === "high") || curated?.tier === "high";
  const models =
    calls.length > 0
      ? calls.map((c) => c.modelName ?? "Model")
      : curated
        ? [curated.modelName ?? "Model"]
        : [];
  const chips = rowChips(card, d.chips, now);
  const showSource = d.showSource || marker;
  const img = d.imageSize === "s" ? 44 : d.imageSize === "l" ? 72 : 56;
  const dexInfo = dexInfoLabel(card.token, now) && <DexInfoLabel token={card.token} now={now} />;

  return (
    <article
      className={`scope-row tone-${badge.tone}${preview ? " preview" : ""}`}
      style={{ "--i": Math.min(index, 10) } as React.CSSProperties}
      onClick={onClick}
    >
      {!preview && <QuickBuyPill mint={card.token.mintAddress} symbol={label} onNeedsPanel={open} />}
      {!preview && onHide && (
        <button
          type="button"
          className="scope-hide"
          onClick={() => onHide(card)}
          title={`Hide ${label} from Scope and Cards. Hidden tokens are listed under Hidden, where you can bring them back.`}
          aria-label={`Hide ${label}`}
        >
          <EyeOffIcon size={12} />
        </button>
      )}
      <div className="scope-avatar">
        <TokenImage
          url={card.token.imageUrl?.startsWith("https://") ? card.token.imageUrl : null}
          size={img * 2}
          width={img}
          height={img}
          className="scope-img"
          preview={!preview}
          fallback={<span className="scope-img placeholder">{(card.token.symbol ?? "?").slice(0, 2)}</span>}
        />
        <QuoteBadge token={card.token} className="scope-quote-badge" />
      </div>
      <div className="scope-main">
        <div className="scope-title">
          <div className="scope-ticker">
            {d.tickerCopiesCa ? (
              <button
                type="button"
                className="scope-symbol copy"
                onClick={copyCa}
                title={`Copy ${label}'s contract address: ${card.token.mintAddress}`}
              >
                {label}
              </button>
            ) : (
              <button
                type="button"
                className="scope-symbol"
                onClick={open}
                title={`${label}: open the token's chart and details`}
              >
                {label}
              </button>
            )}
            <QuotePill token={card.token} className="scope-quote" />
            {/* Beside the ticker, where the Dex pill was (user ask 2026-10-22). */}
            {d.showSearch && (
              <CardSearchButton
                className="scope-search"
                symbol={card.token.symbol}
                name={card.token.name}
                mint={card.token.mintAddress}
              />
            )}
            {!preview && (
              <WatchStar
                className="scope-watch"
                size={12}
                token={{
                  tokenId: card.tokenId,
                  mint: card.token.mintAddress,
                  symbol: card.token.symbol,
                  name: card.token.name,
                  imageUrl: card.token.imageUrl,
                  marketCapUsd: nowMcap,
                }}
              />
            )}
            {copied && (
              <span className="scope-copied" role="status">
                Copied
              </span>
            )}
          </div>
          {d.showName && card.token.name && card.token.symbol && (
            <span className="scope-name" title={card.token.name}>
              {card.token.name}
            </span>
          )}
        </div>
        <div className="scope-meta">
          {d.showFees && <FeeBadge fee={card.token.creatorFee} icon={12} className="scope-fee" />}
          {filter && showSource && (
            <span className="scope-src mine" title={`Caught by your filter “${filter.name}”`}>
              {filter.icon ? <FilterGlyph icon={filter.icon} size={11} /> : <SlidersIcon size={11} />}
              {marker && <span className="scope-src-text">{filter.name}</span>}
            </span>
          )}
          {curated && showSource && (
            <span className="scope-src model" title={models.join(" + ")}>
              <BrainIcon size={11} />
              <span className="scope-src-text">
                {models.length > 1 ? `${models[0]} +${models.length - 1}` : models[0]}
              </span>
            </span>
          )}
          {high && showSource && (
            <span
              className="scope-src model"
              title="High conviction: the model's top half-percent of moments"
            >
              HC
            </span>
          )}
          <SocialLinks links={socials} className="scope-socials" />
          {tradeLinks.map((l) => (
            <a
              key={l.label}
              className="scope-trade-link"
              href={l.href(card.token.mintAddress)}
              target="_blank"
              rel="noreferrer noopener"
              title={`Open ${label} on ${l.label}`}
            >
              {l.label}
            </a>
          ))}
        </div>
      </div>
      <div className="scope-figs">
        <div className={`scope-fig scope-now${nowAge !== null ? " stale" : ""}`} title={nowTitle}>
          {/* The result, left of the market cap rather than over the image (user ask 2026-10-23). */}
          {mark && d.showResult && (
            <span
              className={`scope-result ${markTone}`}
              role="img"
              title={badge.text}
              aria-label={badge.text}
            >
              {/* Inter has no ⊘, and the fallback font draws it larger than the other marks. */}
              {mark === "⊘" ? <span className="result-stop">⊘</span> : mark}
            </span>
          )}
          <span className={`num${move === null ? "" : move >= 0 ? " up" : " down"}`}>
            {usd(nowMcap ?? alertMcap)}
          </span>
        </div>
        {d.showAt && (
          <div className="scope-fig" title="Market cap at the alert">
            <span className="scope-fig-label">at</span>
            <span className="num">{usd(alertMcap)}</span>
          </div>
        )}
        {d.showPeak && peak != null && peak > 0 && (
          <div className="scope-fig" title="Peak since the alert">
            <span className="scope-fig-label">peak</span>
            <span className="num up">+{pct(peak)}</span>
          </div>
        )}
        {/* The Dex pill and the age, under the figures (user ask 2026-10-22). */}
        {(dexInfo || d.showAge) && (
          <div className="scope-fig-pills">
            {dexInfo}
            {d.showAge && (
              <span className={`scope-age age-chip num${d.highlightNew && ageMs < 60_000 ? " new" : ""}`}>
                {shortAge(ageMs)}
              </span>
            )}
          </div>
        )}
      </div>
      {chips.length > 0 && (
        <div className="scope-chips">
          {chips.map((c) => {
            const tl = tileLook(tiles, c.tone, c.risky);
            return (
              <span
                key={c.id}
                className={`scope-chip ${tl.className ?? ""}${c.aged ? " aged" : ""}`}
                style={tl.style}
                title={c.title}
              >
                <span className="scope-chip-label">{c.short}</span>
                <span className="num">{c.value}</span>
              </span>
            );
          })}
        </div>
      )}
    </article>
  );
}
