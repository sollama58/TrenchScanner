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
  ANY_FACETS,
  arrangeHits,
  facetOptions,
  filterCounts,
  REWARDS_KINDS,
  SEARCH_FILTERS,
  SEARCH_SORTS,
  sortCoverage,
  type RewardsKind,
  type SearchFacets,
  type SearchFilter,
  type SearchSort,
} from "../tokenSearch";
import { TokenImage } from "./TokenImage";
import {
  CheckIcon,
  ChefHatIcon,
  ChevronDownIcon,
  CloseIcon,
  GiftIcon,
  HeartIcon,
  RobotIcon,
  SearchIcon,
} from "./Icons";

/** Results each section shows until its Show all is pressed (user ask 2026-10-19). */
const SECTION_LIMIT = 6;

const REWARDS_ICON: Partial<Record<RewardsKind, typeof GiftIcon>> = {
  dev: ChefHatIcon,
  rewards: GiftIcon,
  charity: HeartIcon,
  github: RobotIcon,
};

/**
 * The sort, as a menu rather than the browser's own select: each choice says how many of the
 * results have that figure, a choice none has is off, and the menu says the rest go last.
 */
function SortMenu({
  sort,
  onSort,
  coverage,
  total,
}: {
  sort: SearchSort;
  onSort: (sort: SearchSort) => void;
  coverage: Record<SearchSort, number>;
  total: number;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);
  const current = SEARCH_SORTS.find((s) => s.id === sort)!;
  return (
    <div
      className="search-sort"
      ref={ref}
      onKeyDown={(e) => {
        // Escape closes the menu, not the whole window.
        if (e.key === "Escape" && open) {
          e.preventDefault();
          e.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <button
        type="button"
        className={`search-sort-btn${open ? " open" : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="muted">Sort</span>
        <strong>{current.label}</strong>
        <ChevronDownIcon size={13} />
      </button>
      {open && (
        <div className="search-sort-menu" role="listbox" aria-label="Sort by">
          {SEARCH_SORTS.map((s) => {
            const have = coverage[s.id];
            const none = total > 0 && have === 0 && s.id !== "match";
            return (
              <button
                key={s.id}
                type="button"
                role="option"
                aria-selected={s.id === sort}
                className={`search-sort-option${s.id === sort ? " on" : ""}`}
                disabled={none}
                onClick={() => {
                  onSort(s.id);
                  setOpen(false);
                }}
              >
                <span className="search-sort-check">{s.id === sort && <CheckIcon size={13} />}</span>
                <span>{s.label}</span>
                <span className="search-sort-have num">
                  {s.id === "match" || total === 0 ? "" : none ? "no data" : `${have} of ${total}`}
                </span>
              </button>
            );
          })}
          <p className="search-sort-note">Sorts by the data each token has. Tokens without it go last.</p>
        </div>
      )}
    </div>
  );
}

// The trade window for a coin found outside the feed, with its Trade panel and the trading code
// behind it: loaded the first time a coin is opened to trade, not with the first screen.
const QuickTrade = lazy(() => import("./QuickTrade").then((m) => ({ default: m.QuickTrade })));

// A paid lookup's view is the Utilities tab's own, loaded the first time one is opened from here.
const UtilityTokenModal = lazy(() =>
  import("../tabs/UtilitiesTab").then((m) => ({ default: m.UtilityTokenModal })),
);

/** How long typing rests before a ticker or name is searched: one request per word, not per letter. */
const SEARCH_TYPING_MS = 250;

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

/** GET `base`?search, kept up while the next search runs; and asking the same again. */
function useSearch<T>(base: string, search: string): [Found<T>, () => void] {
  const [found, setFound] = useState<Found<T>>({ state: "idle" });
  const [attempt, setAttempt] = useState(0);
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
  }, [base, search, attempt]);
  // Text too short to search answers nothing, whatever the last search found.
  return [search === "" ? { state: "idle" } : found, () => setAttempt((n) => n + 1)];
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
  external = false,
}: {
  hit: TokenSearchHit;
  now: number;
  active: boolean;
  opening: boolean;
  onOpen: () => void;
  onHover: () => void;
  id: string;
  /** An untracked coin: its market figures in place of the alert ones, and a Trade action. */
  external?: boolean;
}) {
  const label = hit.symbol ? `$${hit.symbol}` : (hit.name ?? shortAddress(hit.mint));
  return (
    <li
      id={id}
      role="option"
      aria-selected={active}
      className={`search-hit${active ? " active" : ""}${opening ? " opening" : ""}${external ? " external" : ""}`}
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
            {external ? "listed" : "launched"} {ago(hit.launchedAt, now)}
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
        {external ? (
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
        {external ? (
          <div className="search-hit-price">
            <span className="util-cost util-cost-free" title="Opens it to trade, free">
              Trade
            </span>
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
 * finds beyond those; opening one opens it to trade (QuickTrade, free), which offers the Utilities
 * tab's coin lookup at its usual price for the full view. A pasted address nothing tracked matches
 * opens to trade by itself (user ask 2026-10-19). Arrow keys move through both sections, Enter
 * opens, Escape closes.
 */
export function SearchModal({ open, onClose, now }: { open: boolean; onClose: () => void; now: number }) {
  const ref = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [filter, setFilter] = useState<SearchFilter>("all");
  const [sort, setSort] = useState<SearchSort>("match");
  const [facets, setFacets] = useState<SearchFacets>(ANY_FACETS);
  // Each section's Show all, undone by a new search.
  const [expanded, setExpanded] = useState({ tracked: false, outside: false });
  const [active, setActive] = useState(0);
  const [opening, setOpening] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  // The untracked coin open to trade (QuickTrade), the pasted address that opened it on its own
  // (once: closing it leaves the search as it was), and the coin whose paid lookup view is open.
  const [trading, setTrading] = useState<string | null>(null);
  const [autoOpened, setAutoOpened] = useState<string | null>(null);
  const [lookedUp, setLookedUp] = useState<string | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  // Coins looked up from here this visit: they open free again (the lookup's re-open window).
  const [paid, setPaid] = useState<ReadonlySet<string>>(new Set());
  const search = useSearchParam(text);
  const [found] = useSearch<TokenSearchAnswer>("/tokens/search", search);
  const [outside, searchOutsideAgain] = useSearch<ExternalSearchAnswer>("/utilities/search", search);

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
  const allHits = useMemo(() => [...hits, ...extraHits], [hits, extraHits]);
  const counts = useMemo(() => filterCounts(allHits, facets), [allHits, facets]);
  const options = useMemo(() => facetOptions(allHits, filter), [allHits, filter]);
  const coverage = useMemo(() => sortCoverage(allHits), [allHits]);
  const shown = useMemo(() => arrangeHits(hits, filter, sort, facets), [hits, filter, sort, facets]);
  const extraShown = useMemo(
    () => arrangeHits(extraHits, filter, sort, facets),
    [extraHits, filter, sort, facets],
  );
  const trackedRows = useMemo(
    () => (expanded.tracked ? shown : shown.slice(0, SECTION_LIMIT)),
    [shown, expanded.tracked],
  );
  const outsideRows = useMemo(
    () => (expanded.outside ? extraShown : extraShown.slice(0, SECTION_LIMIT)),
    [extraShown, expanded.outside],
  );
  const rows = useMemo(() => [...trackedRows, ...outsideRows], [trackedRows, outsideRows]);
  useEffect(() => setExpanded({ tracked: false, outside: false }), [search]);
  // A new list starts at its top.
  useEffect(() => setActive(0), [rows]);

  // A pasted address TrenchScanner doesn't track opens to trade at once (user ask 2026-10-19):
  // whoever pastes a CA most likely means to trade it. It opens on the tracked search's miss, not
  // on DexScreener's answer, which a coin minutes old doesn't have yet; the figures fill in after.
  const query = parseSearch(text);
  const pastedMint = query.kind === "mint" ? query.mint : null;
  useEffect(() => {
    if (!open || !pastedMint || autoOpened === pastedMint) return;
    if (found.state !== "done" || found.for !== search || found.answer.hits.length > 0) return;
    setAutoOpened(pastedMint);
    setScanError(null);
    setTrading(pastedMint);
  }, [open, pastedMint, autoOpened, found, search]);

  /** What the full lookup of a coin costs this wallet. */
  const priceOf = (mint: string): string => {
    const hit = extraHits.find((h) => h.mint === mint);
    if (paid.has(mint)) return FREE_TEXT.open;
    if (hit?.free) return FREE_TEXT[hit.free];
    const cost = extra?.cost ?? 1;
    return `${cost} credit${cost === 1 ? "" : "s"}`;
  };

  const openTracked = async (hit: TokenSearchHit) => {
    if (opening) return;
    setOpening(hit.mint);
    setOpenError(null);
    try {
      const card = await api<Card>(`/tokens/${hit.mint}/card`);
      openTokenModal(card, Date.now());
    } catch (e) {
      setOpenError(e instanceof Error ? e.message : String(e));
    } finally {
      setOpening(null);
    }
  };

  // The Utilities tab's coin lookup, from the trade view's Full scan: charged (or not) by the
  // server, then its view opens here in the trade view's place.
  const lookUp = async (mint: string) => {
    if (opening) return;
    setOpening(mint);
    setScanError(null);
    try {
      await post("/utilities/token", { mint });
      setPaid((p) => new Set(p).add(mint));
      setTrading(null);
      setLookedUp(mint);
    } catch (e) {
      setScanError(e instanceof Error ? e.message : String(e));
    } finally {
      setOpening(null);
    }
  };

  const openExternal = (hit: ExternalSearchHit) => {
    setScanError(null);
    setTrading(hit.mint);
  };

  const openRow = (i: number) => {
    if (i < trackedRows.length) {
      const hit = trackedRows[i];
      if (hit) void openTracked(hit);
      return;
    }
    const hit = outsideRows[i - trackedRows.length];
    if (hit) openExternal(hit);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (rows.length === 0) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      const next = (active + step + rows.length) % rows.length;
      setActive(next);
      document.getElementById(`search-hit-${next}`)?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      e.preventDefault();
      openRow(active);
    }
  };

  const subject =
    query.kind === "mint" ? shortAddress(query.mint) : query.kind === "text" ? `“${query.text}”` : "";
  const busy = found.state === "loading";
  const outsideBusy = outside.state === "loading";
  // Your alerts and Model calls are TrenchScanner's own: nothing untracked has either.
  const outsideApplies = filter === "all" || filter === "graduated";

  const row = (hit: TokenSearchHit, i: number, external = false) => (
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
      external={external}
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
          <SortMenu sort={sort} onSort={setSort} coverage={coverage} total={allHits.length} />
        </div>

        {allHits.length > 0 && (
          <div className="search-facets">
            <div className="search-facet" role="group" aria-label="Rewards type">
              <span className="search-facet-label">Rewards</span>
              <div className="search-seg">
                <button
                  type="button"
                  className={facets.rewards === "any" ? "on" : ""}
                  aria-pressed={facets.rewards === "any"}
                  onClick={() => setFacets((f) => ({ ...f, rewards: "any" }))}
                >
                  Any
                </button>
                {REWARDS_KINDS.filter(
                  (k) => k.id === facets.rewards || options.rewards.some((o) => o.id === k.id),
                ).map((k) => {
                  const Icon = REWARDS_ICON[k.id];
                  return (
                    <button
                      key={k.id}
                      type="button"
                      className={facets.rewards === k.id ? "on" : ""}
                      aria-pressed={facets.rewards === k.id}
                      title={k.title}
                      onClick={() => setFacets((f) => ({ ...f, rewards: f.rewards === k.id ? "any" : k.id }))}
                    >
                      {Icon && <Icon size={13} />}
                      {k.label}
                      <span className="search-chip-count num">
                        {options.rewards.find((o) => o.id === k.id)?.count ?? 0}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="search-facet" role="group" aria-label="Pairing">
              <span className="search-facet-label">Pairing</span>
              <div className="search-seg">
                <button
                  type="button"
                  className={facets.pairing === "any" ? "on" : ""}
                  aria-pressed={facets.pairing === "any"}
                  onClick={() => setFacets((f) => ({ ...f, pairing: "any" }))}
                >
                  Any
                </button>
                {[
                  ...options.pairing,
                  ...(facets.pairing !== "any" && !options.pairing.some((p) => p.label === facets.pairing)
                    ? [{ label: facets.pairing, count: 0 }]
                    : []),
                ].map((p) => (
                  <button
                    key={p.label}
                    type="button"
                    className={facets.pairing === p.label ? "on" : ""}
                    aria-pressed={facets.pairing === p.label}
                    title={`Trades against ${p.label}`}
                    onClick={() =>
                      setFacets((f) => ({ ...f, pairing: f.pairing === p.label ? "any" : p.label }))
                    }
                  >
                    <span className="search-pair-slash" aria-hidden="true">
                      /
                    </span>
                    {p.label}
                    <span className="search-chip-count num">{p.count}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

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
                {trackedRows.map((hit, i) => row(hit, i))}
                {shown.length > SECTION_LIMIT && (
                  <li role="presentation" className="search-more">
                    <button
                      type="button"
                      className="search-more-btn"
                      onClick={() => setExpanded((x) => ({ ...x, tracked: !x.tracked }))}
                    >
                      {expanded.tracked ? "Show fewer" : `Show all ${shown.length} tracked`}
                      <ChevronDownIcon size={13} className={expanded.tracked ? "flip" : ""} />
                    </button>
                  </li>
                )}
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
                {outsideRows.map((hit, j) => row(hit, trackedRows.length + j, true))}
                {pastedMint &&
                  answer?.hits.length === 0 &&
                  outside.state === "done" &&
                  !extraHits.some((h) => h.mint === pastedMint) && (
                    <li role="presentation" className="search-more">
                      <button
                        type="button"
                        className="search-more-btn"
                        onClick={() => {
                          setScanError(null);
                          setTrading(pastedMint);
                        }}
                      >
                        Open {shortAddress(pastedMint)} to trade anyway
                      </button>
                    </li>
                  )}
                {extraShown.length > SECTION_LIMIT && (
                  <li role="presentation" className="search-more">
                    <button
                      type="button"
                      className="search-more-btn"
                      onClick={() => setExpanded((x) => ({ ...x, outside: !x.outside }))}
                    >
                      {expanded.outside ? "Show fewer" : `Show all ${extraShown.length} not tracked`}
                      <ChevronDownIcon size={13} className={expanded.outside ? "flip" : ""} />
                    </button>
                  </li>
                )}
              </>
            )}
          </ul>
        </div>
      </div>
      {trading && (
        <Suspense fallback={<p className="muted small">Opening the coin…</p>}>
          <QuickTrade
            key={trading}
            mint={trading}
            hit={extraHits.find((h) => h.mint === trading) ?? null}
            searching={outside.state === "loading" || (outside.state === "idle" && !!search)}
            searchError={outside.state === "error" ? outside.message : null}
            onSearchAgain={searchOutsideAgain}
            scanPrice={priceOf(trading)}
            scanning={opening === trading}
            scanError={scanError}
            onScan={() => void lookUp(trading)}
            onClose={() => {
              setTrading(null);
              input.current?.focus();
            }}
            now={now}
          />
        </Suspense>
      )}
      {lookedUp && (
        <Suspense fallback={null}>
          <UtilityTokenModal mint={lookedUp} onClose={() => setLookedUp(null)} />
        </Suspense>
      )}
    </dialog>
  );
}
