import { useEffect, useMemo, useRef, useState } from "react";
import { api, type Card, type TokenSearchAnswer, type TokenSearchHit } from "../api";
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

type Found =
  | { state: "idle" }
  | { state: "loading"; for: string; last: TokenSearchAnswer | null }
  | { state: "done"; for: string; answer: TokenSearchAnswer }
  | { state: "error"; for: string; message: string };

/** GET /tokens/search for the box's text: a pasted address at once, typed text once typing rests. */
function useTokenSearch(input: string): Found {
  const typed = parseSearch(input);
  const settled = parseSearch(useSettled(input, SEARCH_TYPING_MS));
  const search = searchParam(typed.kind === "mint" ? typed : settled);
  const [found, setFound] = useState<Found>({ state: "idle" });
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
    api<TokenSearchAnswer>(`/tokens/search?${search}`)
      .then((answer) => live && setFound({ state: "done", for: search, answer }))
      .catch(
        (e: unknown) =>
          live &&
          setFound({ state: "error", for: search, message: e instanceof Error ? e.message : String(e) }),
      );
    return () => {
      live = false;
    };
  }, [search]);
  // Text too short to search answers nothing, whatever the last search found.
  return parseSearch(input).kind === "none" ? { state: "idle" } : found;
}

/** One result: the coin, what TrenchScanner has on it, and its figures. */
function HitRow({
  hit,
  now,
  active,
  opening,
  onOpen,
  onHover,
  id,
}: {
  hit: TokenSearchHit;
  now: number;
  active: boolean;
  opening: boolean;
  onOpen: () => void;
  onHover: () => void;
  id: string;
}) {
  const label = hit.symbol ? `$${hit.symbol}` : (hit.name ?? shortAddress(hit.mint));
  return (
    <li
      id={id}
      role="option"
      aria-selected={active}
      className={`search-hit${active ? " active" : ""}${opening ? " opening" : ""}`}
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
          <span>launched {ago(hit.launchedAt, now)}</span>
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
        <div className="search-fig-wide">
          <dt>Holders</dt>
          <dd className="num">{hit.holderCount?.toLocaleString() ?? "–"}</dd>
        </div>
        <div>
          <dt>Best run</dt>
          <dd className={`num${hit.bestCallPeakPct !== null && hit.bestCallPeakPct >= 100 ? " good" : ""}`}>
            {hit.bestCallPeakPct === null ? "–" : multiple(hit.bestCallPeakPct)}
          </dd>
        </div>
      </dl>
    </li>
  );
}

/**
 * The feed's search window (user ask 2026-10-19): a see-through panel over the feed with the
 * search box on top, every tracked token that matches below, and chips and a sort to narrow and
 * order them. A result opens the token modal over it (free: every result is tracked), and closing
 * that comes back here. Arrow keys move through the results, Enter opens one, Escape closes.
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
  const found = useTokenSearch(text);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      input.current?.select();
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const answer = found.state === "done" ? found.answer : found.state === "loading" ? found.last : null;
  const hits = useMemo(() => answer?.hits ?? [], [answer]);
  const counts = useMemo(() => filterCounts(hits), [hits]);
  const shown = useMemo(() => arrangeHits(hits, filter, sort), [hits, filter, sort]);
  // A new list starts at its top.
  useEffect(() => setActive(0), [shown]);

  const openHit = async (hit: TokenSearchHit) => {
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

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (shown.length === 0) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      const next = (active + step + shown.length) % shown.length;
      setActive(next);
      document.getElementById(`search-hit-${next}`)?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      e.preventDefault();
      const hit = shown[active];
      if (hit) void openHit(hit);
    }
  };

  const query = parseSearch(text);
  const subject =
    query.kind === "mint" ? shortAddress(query.mint) : query.kind === "text" ? `“${query.text}”` : "";
  const busy = found.state === "loading";

  return (
    <dialog
      ref={ref}
      className="about-modal search-modal"
      aria-label="Search tracked tokens"
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
        <div className={`search-field${busy ? " busy" : ""}`} role="search">
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
            aria-activedescendant={shown.length > 0 ? `search-hit-${active}` : undefined}
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
                {answer && <span className="search-chip-count num">{counts[f.id]}</span>}
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

        <div className="search-results" aria-live="polite" aria-busy={busy}>
          {found.state === "idle" && (
            <p className="search-empty muted">
              Type a ticker or name (two letters or more), or paste a contract address or token link.
            </p>
          )}
          {found.state === "error" && <p className="error">Couldn&apos;t search: {found.message}</p>}
          {openError && <p className="error">Couldn&apos;t open that token: {openError}</p>}
          {answer && (
            <>
              <p className="search-section-head">
                <span>Tracked</span>
                <span className="muted small">
                  {hits.length === 0
                    ? `Nothing TrenchScanner tracks matches ${subject}.`
                    : `${shown.length} of ${hits.length}${answer.truncated ? "+" : ""} for ${subject}`}
                </span>
              </p>
              {hits.length > 0 && shown.length === 0 && (
                <p className="search-empty muted">None of these match that filter.</p>
              )}
              <ul id="search-hits" role="listbox" className="search-hits" aria-label="Tracked tokens">
                {shown.map((hit, i) => (
                  <HitRow
                    key={hit.mint}
                    id={`search-hit-${i}`}
                    hit={hit}
                    now={now}
                    active={i === active}
                    opening={opening === hit.mint}
                    onOpen={() => void openHit(hit)}
                    onHover={() => setActive(i)}
                  />
                ))}
              </ul>
              {answer.truncated && (
                <p className="muted small center">
                  Showing the closest matches. Type more to narrow it down.
                </p>
              )}
            </>
          )}
          {!answer && busy && (
            <div className="search-skeleton" aria-hidden="true">
              {[0, 1, 2].map((i) => (
                <div key={i} className="search-hit skeleton-row" />
              ))}
            </div>
          )}
        </div>
      </div>
    </dialog>
  );
}
