import { SectionBoundary } from "./SectionBoundary";
import { ScopeRowSkeletons } from "./Skeleton";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Card, LaunchPage, MatchPage } from "../api";
import {
  passesColumnFilter,
  withinMaxAge,
  useScopeSettings,
  activeFilterCount,
  cardModelNames,
  type ScopeDisplay,
} from "../scopeSettings";
import { rowChips } from "../scopeChips";
import { ScopeSettingsModal, type ScopeSettingsSection } from "./ScopeSettingsModal";
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
  emptyColumns,
  frameOf,
  holdFrame,
  SCOPE_COLUMNS,
  SCOPE_PAGES,
  SCOPE_STREAM_PAGES,
  scopeColumnsFor,
  scopeTickIds,
  shortAge,
  splitScope,
  swipeStep,
  type ScopeColumn,
  type ScopeColumns,
  type ScopeFrame,
  type ScopeHold,
} from "../scope";
import {
  feeBadge,
  LINKS,
  nowReading,
  nowReadingAge,
  QuotePill,
  recordedPeakOf,
  socialLinks,
} from "./AlertCard";
import { QuickBuyPill } from "./QuickBuyPill";
import { TokenImage } from "./TokenImage";
import { FilterGlyph } from "./FilterBadge";
import { BrainIcon, EyeOffIcon, FunnelIcon, SlidersIcon } from "./Icons";
import { dueToUnhide, hideToken, unhideTokens, useHiddenTokenIds, useHiddenTokens } from "../hiddenTokens";
import { XLinkPreview } from "./XLinkPreview";

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
  settingsSection,
  onSettings,
}: {
  /** The Live feed's page `n`, so Scope reads exactly what the cards view does. */
  feedPath: (n: number) => string;
  modelsOn: boolean;
  /**
   * Pro: coins the wallet holds (heldTokens.ts), which skip hiding and the columns' filters but
   * "older than", and keep the column and place they'd have anyway.
   */
  heldTokenIds?: ReadonlySet<string>;
  /** The Scope settings window's open section (the Live header's Customize opens Display), or null. */
  settingsSection: ScopeSettingsSection | null;
  onSettings: (section: ScopeSettingsSection | null) => void;
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
  const graduated = usePolling<LaunchPage>(GRADUATED_PATH, GRADUATED_POLL_MS);
  // Stream on: the Stream's newest pages too, for New and About to graduate.
  const streamOn = display.stream;
  const streamPaths = streamOn
    ? Array.from({ length: SCOPE_STREAM_PAGES }, (_, i) =>
        i === 0 ? STREAM_PATH : `${STREAM_PATH}?page=${i + 1}`,
      )
    : [];
  const streamPages = usePollingAll<LaunchPage>(streamPaths, GRADUATED_POLL_MS);
  // Each column fills in as its own source answers: the feed, the graduated list and the Stream
  // are three requests, and none waits on the others (user ask 2026-10-18).
  const streamFirst = streamPages.data[0];
  const buffer = useMemo(() => {
    if (!first.data && !graduated.data && !streamFirst) return undefined;
    const grad = graduated.data?.launches ?? [];
    const gradIds = new Set(grad.map((c) => c.id));
    const stream: Card[] = [];
    // A page still loading ends the run, as on the feed.
    for (const p of streamPages.data) {
      if (!p) break;
      for (const c of p.launches) if (!gradIds.has(c.id)) stream.push(c);
    }
    const feed = first.data ? joinPages([first.data, ...more.data]) : [];
    return [...feed, ...grad, ...stream];
  }, [first.data, more.data, graduated.data, streamPages.data, streamFirst]);
  const [tickIds, setTickIds] = useState<string[] | undefined>(undefined);
  const visible = useLiveMarketCaps(buffer, tickIds);

  const gradIds = useMemo(() => new Set((graduated.data?.launches ?? []).map((c) => c.id)), [graduated.data]);
  const gradTokens = useMemo(
    () => new Set((graduated.data?.launches ?? []).map((c) => c.tokenId)),
    [graduated.data],
  );
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
    const shown =
      hiddenIds.size > 0
        ? visible.filter((c) => !hiddenIds.has(c.tokenId) || heldTokenIds.has(c.tokenId))
        : visible;
    return splitScope(
      shown.filter((c) => c.kind !== "stream"),
      shown.filter((c) => c.kind === "stream" && gradIds.has(c.id)),
      {
        filters: settings.columns.filters.showGraduated,
        models: settings.columns.models.showGraduated,
      },
      shown.filter((c) => c.kind === "stream" && !gradIds.has(c.id)),
    );
  }, [
    visible,
    hiddenIds,
    heldTokenIds,
    gradIds,
    settings.columns.filters.showGraduated,
    settings.columns.models.showGraduated,
  ]);
  // Each column through its own filters (Scope's settings, not Customize's).
  const fresh = useMemo(() => {
    if (!unfiltered) return undefined;
    const out = { ...unfiltered };
    for (const { id } of SCOPE_COLUMNS) {
      const f = settings.columns[id];
      out[id] =
        activeFilterCount(f) > 0
          ? unfiltered[id].filter((c) =>
              heldTokenIds.has(c.tokenId) ? withinMaxAge(c, f, now) : passesColumnFilter(c, f, id, now),
            )
          : unfiltered[id];
    }
    return out;
  }, [unfiltered, settings.columns, now, heldTokenIds]);
  const modelNames = useMemo(
    () => [...new Set((unfiltered?.models ?? []).flatMap(cardModelNames))],
    [unfiltered],
  );
  const filterNames = useMemo(
    () => [...new Set((unfiltered?.filters ?? []).flatMap((c) => (c.filter ? [c.filter.name] : [])))],
    [unfiltered],
  );
  const boardCols = scopeColumnsFor(streamOn);
  const unhidden = boardCols.filter((c) => !display.hiddenColumns.includes(c.id));
  const shownCols = unhidden.length > 0 ? unhidden : boardCols;

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
  const heldCols: ScopeColumns = held?.cols ?? fresh ?? emptyColumns();
  // A held board keeps its rows, but not one just hidden.
  let cols = heldCols;
  if (held && hiddenIds.size > 0) {
    cols = emptyColumns();
    for (const { id } of SCOPE_COLUMNS)
      cols[id] = heldCols[id].filter((c) => !hiddenIds.has(c.tokenId) || heldTokenIds.has(c.tokenId));
  }
  // Columns whose source hasn't answered yet show placeholder rows, not "nothing here".
  const loading = (id: ScopeColumn) =>
    id === "graduated"
      ? !graduated.data && !graduated.error
      : id === "new" || id === "soon"
        ? !streamFirst && !streamPages.error
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
  // Stream on or off is a different board: start it live.
  useEffect(() => setFrame(null), [streamOn]);
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
  // New filters show at once, even on a held board: it holds still from the filtered rows.
  const columnFilters = settings.columns;
  useEffect(() => {
    setFrame((f) => (f && freshRef.current ? frameOf(freshRef.current) : f));
  }, [columnFilters]);

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
  const [active, setActive] = useState<ScopeColumn>("filters");
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
  const activeCol = shownCols.some((c) => c.id === active) ? active : (shownCols[0]?.id ?? "filters");
  const filterButton = (id: ScopeColumn, label: string) => {
    const count = activeFilterCount(settings.columns[id]);
    return (
      <button
        type="button"
        className={`ghost icon-btn scope-filter-btn${count > 0 ? " on" : ""}`}
        onClick={() => onSettings(id)}
        title={`Filter what shows in ${label}${count > 0 ? ` (${count} on)` : ""}`}
        aria-label={`Filter ${label}${count > 0 ? `, ${count} filters on` : ""}`}
      >
        <FunnelIcon size={14} />
        {count > 0 && <span className="scope-filter-count num">{count}</span>}
      </button>
    );
  };
  const tiles = tileMode(look);
  const modal = (
    <ScopeSettingsModal
      open={settingsSection !== null}
      section={settingsSection ?? "display"}
      onClose={() => onSettings(null)}
      modelNames={modelNames}
      filterNames={filterNames}
      tiles={tiles}
    />
  );

  if (first.error && !first.data && !graduated.data && !streamFirst)
    return <p className="error">Couldn&apos;t load your feed: {first.error.message}</p>;

  return (
    <div
      ref={root}
      className={`scope${paused ? " held" : ""}${first.stale ? " stale" : ""} ${scopeLookClass(display)}`}
      style={{ "--scope-cols": shownCols.length } as React.CSSProperties}
      onPointerEnter={(e) => e.pointerType === "mouse" && setHold("pointer", true)}
      onPointerLeave={(e) => e.pointerType === "mouse" && setHold("pointer", false)}
      onTouchStart={touchStart}
      onTouchEnd={touchEnd}
      onTouchCancel={touchEnd}
    >
      {modal}
      <div className="scope-bar" ref={bar}>
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
              {c.short} <span className="num muted">{cols[c.id].length}</span>
            </button>
          ))}
        </div>
        <span className="scope-bar-filter">
          {filterButton(activeCol, SCOPE_COLUMNS.find((c) => c.id === activeCol)!.label)}
        </span>
        <span
          className="scope-hold muted small"
          aria-live="polite"
          title={
            paused
              ? phone
                ? "Held still while you're scrolled down: new rows wait behind the New pill"
                : "Held still while you read: new rows wait behind the New pill"
              : "New rows land as they come"
          }
        >
          {paused ? "Paused" : "Live"}
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
            className={`scope-col scope-col-${c.id}${activeCol === c.id ? " active" : ""}`}
            aria-label={c.label}
          >
            <header className="scope-col-head">
              <h3 title={c.hint}>{c.label}</h3>
              <span className="num muted">{cols[c.id].length}</span>
              {filterButton(c.id, c.label)}
            </header>
            <div className="scope-rows" onScroll={(e) => onColScroll(c.id, e.currentTarget.scrollTop)}>
              {cols[c.id].length === 0 && loading(c.id) ? (
                <ScopeRowSkeletons />
              ) : cols[c.id].length === 0 ? (
                <p className="muted small scope-empty">
                  {(unfiltered?.[c.id].length ?? 0) > 0
                    ? "Nothing here passes this column's filters right now."
                    : emptyText(c.id, modelsOn, graduated.error, streamPages.error, first.error)}
                </p>
              ) : (
                cols[c.id].map((card, i) => (
                  <SectionBoundary key={card.id} label="This row" size="card" resetKey={card}>
                    <ScopeRow
                      index={i}
                      card={card}
                      now={now}
                      display={display}
                      tiles={tiles}
                      marker={c.id === "graduated"}
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

function emptyText(
  col: ScopeColumn,
  modelsOn: boolean,
  gradError: Error | null,
  streamError: Error | null,
  feedError: Error | null,
): string {
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
  const mark = outcome && badge.tone !== "neutral" && badge.tone !== "info" ? badge.text.split(" ")[0] : null;
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
  const fees = d.showFees ? feeBadge(card.token.creatorFee) : null;
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
        {mark && d.showResult && (
          <span className={`scope-mark ${badge.tone}`} role="img" title={badge.text} aria-label={badge.text}>
            {mark}
          </span>
        )}
      </div>
      <div className="scope-main">
        <div className="scope-title">
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
          {copied && (
            <span className="scope-copied" role="status">
              Copied
            </span>
          )}
          {d.showName && card.token.name && card.token.symbol && (
            <span className="scope-name" title={card.token.name}>
              {card.token.name}
            </span>
          )}
        </div>
        <div className="scope-meta">
          {d.showAge && (
            <span className={`scope-age num${d.highlightNew && ageMs < 60_000 ? " new" : ""}`}>
              {shortAge(ageMs)}
            </span>
          )}
          {fees && (
            <span
              className={`fee-badge scope-fee fee-${fees.kind}`}
              title={fees.title}
              aria-label={fees.title}
            >
              <fees.Icon size={12} />
            </span>
          )}
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
          {socials.map((l) => (
            <XLinkPreview
              key={l.key}
              className="scope-link"
              href={l.url}
              target="_blank"
              rel="noreferrer noopener"
              title={`${l.label}: ${l.url.replace(/^https:\/\//, "").replace(/\/$/, "")}`}
              aria-label={`Open the coin's ${l.label}`}
            >
              <l.Icon size={11} />
            </XLinkPreview>
          ))}
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
