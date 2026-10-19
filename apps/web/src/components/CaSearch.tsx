import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  post,
  type Card,
  type ExternalSearchAnswer,
  type ExternalSearchHit,
  type TokenSearchAnswer,
  type TokenSearchHit,
} from "../api";
import { ago, multiple, shortAddress, usd } from "../format";
import { parseSearch, searchParam } from "../caSearch";
import { openTokenModal } from "../tokenModal";
import {
  arrangeHits,
  filterCounts,
  SEARCH_FILTERS,
  SEARCH_SORTS,
  type SearchFilter,
  type SearchSort,
} from "../tokenSearch";
import { TokenImage } from "./TokenImage";
import { CloseIcon, SearchIcon } from "./Icons";

// A paid lookup's view is the Utilities tab's own, loaded the first time one is opened from here.
const UtilityTokenModal = lazy(() =>
  import("../tabs/UtilitiesTab").then((m) => ({ default: m.UtilityTokenModal })),
);

/** How long typing rests before a ticker or name is searched: one request per word, not per letter. */
const SEARCH_TYPING_MS = 250;

/** Whether a key press landed somewhere that types text, so "/" there is a character, not a shortcut. */
function typingIn(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
}

/**
 * The feed's search pill, by contract address, ticker or name, among the feed's other controls.
 * It opens the search window (SearchModal) rather than searching in place (user ask 2026-10-19);
 * "/" anywhere on the page opens it too.
 */
export function CaSearchButton({ onOpen, title }: { onOpen: () => void; title: string }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey || typingIn(e.target)) return;
      // A dialog over the feed keeps its own keys.
      if (document.querySelector("dialog[open]")) return;
      e.preventDefault();
      onOpen();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onOpen]);

  return (
    <button type="button" className="ca-search ca-search-button" onClick={onOpen} title={title}>
      <SearchIcon size={14} className="ca-search-icon" />
      <span className="ca-search-placeholder">Ticker, name or CA</span>
      <kbd className="ca-search-key" aria-hidden="true">
        /
      </kbd>
    </button>
  );
}

/** `value`, once it has stopped changing for `ms`. */
function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), ms);
    return () => window.clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

type Found<T> =
  | { state: "idle" }
  | { state: "loading"; for: string; last: T | null }
  | { state: "done"; for: string; answer: T }
  | { state: "error"; for: string; message: string };

/** The search's text as the API's query string: a pasted address at once, typed text once typing rests. */
function useSearchParam(input: string): string {
  const typed = parseSearch(input);
  const settled = parseSearch(useSettled(input, SEARCH_TYPING_MS));
  return parseSearch(input).kind === "none" ? "" : searchParam(typed.kind === "mint" ? typed : settled);
}

/** GET `base`?search, kept up while the next search runs. */
function useSearch<T>(base: string, search: string): Found<T> {
  const [found, setFound] = useState<Found<T>>({ state: "idle" });
  useEffect(() => {
    if (!search) {
      setFound({ state: "idle" });
      return;
    }
    let live = true;
    setFound((f) => ({
      state: "loading",
      for: search,
      last: f.state === "done" ? f.answer : f.state === "loading" ? f.last : null,
    }));
    api<T>(`${base}?${search}`)
      .then((answer) => live && setFound({ state: "done", for: search, answer }))
      .catch(
        (e: unknown) =>
          live &&
          setFound({ state: "error", for: search, message: e instanceof Error ? e.message : String(e) }),
      );
    return () => {
      live = false;
    };
  }, [base, search]);
  // Text too short to search answers nothing, whatever the last search found.
  return search === "" ? { state: "idle" } : found;
}

const answerOf = <T,>(found: Found<T>): T | null =>
  found.state === "done" ? found.answer : found.state === "loading" ? found.last : null;

/** Why opening an untracked coin costs nothing (the API's quote reasons). */
const FREE_TEXT: Record<NonNullable<ExternalSearchHit["free"]>, string> = {
  tracked: "Free",
  traded: "Free, you traded it",
  own: "Free",
  open: "Free, already open",
};

/** One result: the coin, what TrenchScanner has on it, and its figures. */
function HitRow({
  hit,
  now,
  active,
  opening,
  onOpen,
  onHover,
  id,
  price,
  confirm,
}: {
  hit: TokenSearchHit;
  now: number;
  active: boolean;
  opening: boolean;
  onOpen: () => void;
  onHover: () => void;
  id: string;
  /** An untracked coin: what opening it costs, in place of the alert figures. */
  price?: string;
  /** The lookup waiting for a yes: the price gives way to Look up and Cancel, in the row itself. */
  confirm?: { onConfirm: () => void; onCancel: () => void };
}) {
  const label = hit.symbol ? `$${hit.symbol}` : (hit.name ?? shortAddress(hit.mint));
  return (
    <li
      id={id}
      role="option"
      aria-selected={active}
      className={`search-hit${active ? " active" : ""}${opening ? " opening" : ""}${price ? " external" : ""}`}
      onClick={onOpen}
      onMouseMove={onHover}
    >
      <TokenImage
        url={hit.imageUrl?.startsWith("https://") ? hit.imageUrl : null}
        size={80}
        width={40}
        height={40}
        className="search-hit-img"
        fallback={<span className="search-hit-img placeholder">{(hit.symbol ?? "?").slice(0, 2)}</span>}
      />
      <div className="search-hit-main">
        <div className="search-hit-title">
          <strong>{label}</strong>
          {hit.name && hit.symbol && <span className="search-hit-name">{hit.name}</span>}
        </div>
        <div className="search-hit-sub">
          <span className="num">{shortAddress(hit.mint)}</span>
          <span>
            {price ? "listed" : "launched"} {ago(hit.launchedAt, now)}
          </span>
          {hit.yourAlertAt && (
            <span className="search-tag yours" title="One of your filters alerted on it">
              Your alert {ago(hit.yourAlertAt, now)}
            </span>
          )}
          {hit.modelCalls > 0 && (
            <span
              className="search-tag called"
              title={hit.lastCallAt ? `Newest call ${ago(hit.lastCallAt, now)}` : undefined}
            >
              {hit.modelCalls === 1 ? "1 model call" : `${hit.modelCalls} model calls`}
            </span>
          )}
          {hit.graduated && <span className="search-tag">Graduated</span>}
        </div>
      </div>
      <dl className="search-hit-figs">
        <div>
          <dt>MC</dt>
          <dd className="num">{usd(hit.marketCapUsd)}</dd>
        </div>
        <div className="search-fig-wide">
          <dt>Vol 24h</dt>
          <dd className="num">{usd(hit.volume24hUsd)}</dd>
        </div>
        {price ? (
          <div className="search-fig-wide">
            <dt>Liquidity</dt>
            <dd className="num">{usd(hit.liquidityUsd)}</dd>
          </div>
        ) : (
          <div className="search-fig-wide">
            <dt>Holders</dt>
            <dd className="num">{hit.holderCount?.toLocaleString() ?? "–"}</dd>
          </div>
        )}
        {price ? (
          <div className="search-hit-price">
            {confirm ? (
              <span className="search-confirm" onClick={(e) => e.stopPropagation()}>
                <button type="button" className="link small" onClick={confirm.onCancel} disabled={opening}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="primary small-btn"
                  onClick={confirm.onConfirm}
                  disabled={opening}
                  title="Scans it and opens its chart, holders and TokenSage read"
                  autoFocus
                >
                  {opening ? "Looking up…" : `Look up · ${price}`}
                </button>
              </span>
            ) : (
              <span className={`util-cost num${price.startsWith("Free") ? " util-cost-free" : ""}`}>
                {price}
              </span>
            )}
          </div>
        ) : (
          <div>
            <dt>Best run</dt>
            <dd className={`num${hit.bestCallPeakPct !== null && hit.bestCallPeakPct >= 100 ? " good" : ""}`}>
              {hit.bestCallPeakPct === null ? "–" : multiple(hit.bestCallPeakPct)}
            </dd>
          </div>
        )}
      </dl>
    </li>
  );
}

/**
 * The feed's search window (user ask 2026-10-19): a see-through panel over the feed with the
 * search box on top, chips and a sort to narrow and order the results, then two sections. Tracked
 * lists every token TrenchScanner tracks that matches; a result opens the token modal over the
 * window (free), and closing that comes back here. Not tracked lists what DexScreener's search
 * finds beyond those; opening one is the Utilities tab's coin lookup at its usual price, asked
 * for first, unless the reader already has it open or traded it. Arrow keys move through both
 * sections, Enter opens (or asks), Escape closes.
 */
export function SearchModal({
  open,
  onClose,
  now,
  scope = false,
}: {
  open: boolean;
  onClose: () => void;
  now: number;
  /** Opened from Scope: results open in Scope's token page layout. */
  scope?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [filter, setFilter] = useState<SearchFilter>("all");
  const [sort, setSort] = useState<SearchSort>("match");
  const [active, setActive] = useState(0);
  const [opening, setOpening] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  // The untracked coin whose lookup is waiting for a yes, and the one whose paid view is open.
  const [confirming, setConfirming] = useState<string | null>(null);
  const [lookedUp, setLookedUp] = useState<string | null>(null);
  // Coins looked up from here this visit: they open free again (the lookup's re-open window).
  const [paid, setPaid] = useState<ReadonlySet<string>>(new Set());
  const search = useSearchParam(text);
  const found = useSearch<TokenSearchAnswer>("/tokens/search", search);
  const outside = useSearch<ExternalSearchAnswer>("/utilities/search", search);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      input.current?.select();
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const answer = answerOf(found);
  const extra = answerOf(outside);
  const hits = useMemo(() => answer?.hits ?? [], [answer]);
  const extraHits = useMemo(() => extra?.hits ?? [], [extra]);
  const counts = useMemo(() => filterCounts([...hits, ...extraHits]), [hits, extraHits]);
  const shown = useMemo(() => arrangeHits(hits, filter, sort), [hits, filter, sort]);
  const extraShown = useMemo(() => arrangeHits(extraHits, filter, sort), [extraHits, filter, sort]);
  const rows = useMemo(() => [...shown, ...extraShown], [shown, extraShown]);
  // A new list starts at its top, with nothing waiting for a yes.
  useEffect(() => {
    setActive(0);
    setConfirming(null);
  }, [rows]);

  const priceOf = (hit: ExternalSearchHit): string => {
    if (paid.has(hit.mint)) return FREE_TEXT.open;
    if (hit.free) return FREE_TEXT[hit.free];
    const cost = extra?.cost ?? 1;
    return `${cost} credit${cost === 1 ? "" : "s"}`;
  };
  const freeToOpen = (hit: ExternalSearchHit) => paid.has(hit.mint) || hit.free !== null;

  const openTracked = async (hit: TokenSearchHit) => {
    if (opening) return;
    setOpening(hit.mint);
    setOpenError(null);
    try {
      const card = await api<Card>(`/tokens/${hit.mint}/card`);
      openTokenModal(card, Date.now(), scope);
    } catch (e) {
      setOpenError(e instanceof Error ? e.message : String(e));
    } finally {
      setOpening(null);
    }
  };

  // The Utilities tab's coin lookup: charged (or not) by the server, then its view opens here.
  const lookUp = async (hit: ExternalSearchHit) => {
    if (opening) return;
    setOpening(hit.mint);
    setOpenError(null);
    try {
      await post("/utilities/token", { mint: hit.mint });
      setPaid((p) => new Set(p).add(hit.mint));
      setConfirming(null);
      setLookedUp(hit.mint);
    } catch (e) {
      setOpenError(e instanceof Error ? e.message : String(e));
    } finally {
      setOpening(null);
    }
  };

  const openExternal = (hit: ExternalSearchHit) => {
    if (freeToOpen(hit)) void lookUp(hit);
    else setConfirming((c) => (c === hit.mint ? null : hit.mint));
  };

  const openRow = (i: number) => {
    if (i < shown.length) {
      const hit = shown[i];
      if (hit) void openTracked(hit);
      return;
    }
    const hit = extraShown[i - shown.length];
    if (!hit) return;
    if (confirming === hit.mint) void lookUp(hit);
    else openExternal(hit);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (rows.length === 0) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      const next = (active + step + rows.length) % rows.length;
      setActive(next);
      setConfirming(null);
      document.getElementById(`search-hit-${next}`)?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      e.preventDefault();
      openRow(active);
    }
  };

  const query = parseSearch(text);
  const subject =
    query.kind === "mint" ? shortAddress(query.mint) : query.kind === "text" ? `“${query.text}”` : "";
  const busy = found.state === "loading";
  const outsideBusy = outside.state === "loading";
  // Your alerts and Model calls are TrenchScanner's own: nothing untracked has either.
  const outsideApplies = filter === "all" || filter === "graduated";

  const row = (
    hit: TokenSearchHit,
    i: number,
    price?: string,
    confirm?: { onConfirm: () => void; onCancel: () => void },
  ) => (
    <HitRow
      key={hit.mint}
      id={`search-hit-${i}`}
      hit={hit}
      now={now}
      active={i === active}
      opening={opening === hit.mint}
      onOpen={() => {
        setActive(i);
        openRow(i);
      }}
      onHover={() => setActive(i)}
      price={price}
      confirm={confirm}
    />
  );

  return (
    <dialog
      ref={ref}
      className="about-modal search-modal"
      aria-label="Search tokens"
      onClose={(e) => {
        // Only this dialog's own close: a nested dialog's close bubbles up through React.
        if (e.target === e.currentTarget) onClose();
      }}
      // A click on the backdrop lands on the dialog element itself; clicks inside land on its content.
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="search-body">
        <div className={`search-field${busy || outsideBusy ? " busy" : ""}`} role="search">
          <SearchIcon size={18} className="search-field-icon" />
          <input
            ref={input}
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search a ticker, name or contract address"
            aria-label="Search by contract address, ticker or name"
            aria-controls="search-hits"
            aria-activedescendant={rows.length > 0 ? `search-hit-${active}` : undefined}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            enterKeyHint="search"
            autoFocus
          />
          {text && (
            <button
              type="button"
              className="ca-search-clear"
              onClick={() => {
                setText("");
                input.current?.focus();
              }}
              aria-label="Clear the search"
              title="Clear"
            >
              <CloseIcon size={12} />
            </button>
          )}
          <button type="button" className="ghost search-close" onClick={onClose} title="Close (Esc)">
            Esc
          </button>
        </div>

        <div className="search-tools">
          <div className="search-chips" role="group" aria-label="Show">
            {SEARCH_FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                className={`search-chip${filter === f.id ? " on" : ""}`}
                aria-pressed={filter === f.id}
                title={f.title}
                onClick={() => setFilter(f.id)}
              >
                {f.label}
                {(answer || extra) && <span className="search-chip-count num">{counts[f.id]}</span>}
              </button>
            ))}
          </div>
          <label className="search-sort">
            <span className="muted small">Sort</span>
            <select value={sort} onChange={(e) => setSort(e.target.value as SearchSort)}>
              {SEARCH_SORTS.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="search-results" aria-live="polite" aria-busy={busy || outsideBusy}>
          {found.state === "idle" && (
            <p className="search-empty muted">
              Type a ticker or name (two letters or more), or paste a contract address or token link.
            </p>
          )}
          {found.state === "error" && <p className="error">Couldn&apos;t search: {found.message}</p>}
          {openError && <p className="error">Couldn&apos;t open that token: {openError}</p>}
          <ul id="search-hits" role="listbox" className="search-hits" aria-label="Search results">
            {answer && (
              <>
                <li className="search-section-head" role="presentation">
                  <span>Tracked</span>
                  <span className="muted small">
                    {hits.length === 0
                      ? `Nothing TrenchScanner tracks matches ${subject}.`
                      : `${shown.length} of ${hits.length}${answer.truncated ? "+" : ""} for ${subject}`}
                  </span>
                </li>
                {hits.length > 0 && shown.length === 0 && (
                  <li className="search-empty muted" role="presentation">
                    None of these match that filter.
                  </li>
                )}
                {shown.map((hit, i) => row(hit, i))}
                {answer.truncated && (
                  <li className="muted small center" role="presentation">
                    Showing the closest tracked matches. Type more to narrow it down.
                  </li>
                )}
              </>
            )}
            {!answer && busy && (
              <li className="search-skeleton" aria-hidden="true">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="search-hit skeleton-row" />
                ))}
              </li>
            )}
            {found.state !== "idle" && outsideApplies && (
              <>
                <li className="search-section-head" role="presentation">
                  <span>Not tracked</span>
                  <span className="muted small">
                    {extra
                      ? extraHits.length === 0
                        ? "Nothing else found on DexScreener."
                        : `${extraShown.length} on DexScreener${
                            extra.balance !== null
                              ? ` · ${extra.balance} credit${extra.balance === 1 ? "" : "s"}${
                                  extra.freeLeft ? ` + ${extra.freeLeft} free today` : ""
                                }`
                              : ""
                          }`
                      : outside.state === "error"
                        ? `Couldn't search outside TrenchScanner: ${outside.message}`
                        : "Searching DexScreener…"}
                  </span>
                </li>
                {extraShown.map((hit, j) => {
                  const i = shown.length + j;
                  return row(
                    hit,
                    i,
                    priceOf(hit),
                    confirming === hit.mint
                      ? {
                          onConfirm: () => void lookUp(hit),
                          onCancel: () => {
                            setConfirming(null);
                            input.current?.focus();
                          },
                        }
                      : undefined,
                  );
                })}
              </>
            )}
          </ul>
        </div>
      </div>
      {lookedUp && (
        <Suspense fallback={null}>
          <UtilityTokenModal mint={lookedUp} onClose={() => setLookedUp(null)} />
        </Suspense>
      )}
    </dialog>
  );
}
