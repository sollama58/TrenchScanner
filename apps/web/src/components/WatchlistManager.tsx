import { useEffect, useId, useRef, useState } from "react";
import { api, type TokenSearchAnswer, type TokenSearchHit } from "../api";
import { parseSearch, searchParam } from "../caSearch";
import { ago, shortAddress, signedPct, usd } from "../format";
import {
  clearWatchlist,
  fullText,
  moveWatched,
  unwatchToken,
  useWatchlist,
  watchMint,
  type WatchlistItem,
} from "../watchlist";
import { changeTone, dayChange, hourChange, isStale, openWatched, watchLabel } from "../watchlistView";
import { ChevronDownIcon, CloseIcon, PlusIcon, SearchIcon, StarIcon, TrashIcon } from "./Icons";
import { Spinner } from "./Loading";
import { TokenImage } from "./TokenImage";

const SEARCH_DELAY_MS = 350;
const SEARCH_HITS = 6;

type Found =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "done"; hits: TokenSearchHit[] }
  | { state: "error"; message: string };

/**
 * The whole Watchlist to manage (user ask 2026-10-23): add a token by its contract address or
 * ticker, reorder, open, remove, clear. The Utilities tab shows it as a section; the market bar's
 * "+N" opens it in WatchlistDialog. Every figure is the one the panel shows (see watchlist.ts).
 */
export function WatchlistManager({
  compact = false,
  onOpened,
}: {
  compact?: boolean;
  /** After a token's view opens (the dialog closes itself so the view is on top). */
  onOpened?: () => void;
}) {
  const { status, items, cap, notice } = useWatchlist();
  const [now, setNow] = useState(() => Date.now());
  const [confirmClear, setConfirmClear] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const full = items.length >= cap;

  useEffect(() => setNow(Date.now()), [items]);
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, []);
  useEffect(() => {
    if (items.length === 0) setConfirmClear(false);
  }, [items.length]);

  const open = (item: WatchlistItem) => {
    setError(null);
    openWatched(item)
      .then(() => onOpened?.())
      .catch((e: unknown) =>
        setError(`Couldn't open ${watchLabel(item)}${e instanceof Error ? `: ${e.message}` : ""}`),
      );
  };

  if (status === "off") {
    return (
      <div className="wlm wlm-off">
        <StarIcon size={18} />
        <p>Sign in with access to keep a watchlist.</p>
      </div>
    );
  }

  return (
    <div className={`wlm${compact ? " compact" : ""}`}>
      <div className="wlm-top">
        <WatchlistAdd full={full} cap={cap} watched={items} />
        <div
          className={`wlm-meter${full ? " full" : ""}`}
          role="meter"
          aria-valuemin={0}
          aria-valuemax={cap}
          aria-valuenow={items.length}
          aria-label={`${items.length} of ${cap} watched`}
          title={full ? fullText(cap) : `${items.length} of ${cap} tokens`}
        >
          <span className="num">{`${items.length}/${cap}`}</span>
          <span className="wlm-meter-bar" aria-hidden>
            <span style={{ width: `${Math.min(100, (items.length / cap) * 100)}%` }} />
          </span>
        </div>
      </div>

      {(error ?? notice) && (
        <p className="wlm-notice" role="status">
          {error ?? notice}
        </p>
      )}

      {items.length === 0 ? (
        status === "loading" || status === "idle" ? (
          <div className="wlm-empty">
            <Spinner size={14} />
          </div>
        ) : (
          <div className="wlm-empty">
            <StarIcon size={20} />
            <strong>Nothing watched yet</strong>
            <span className="muted small">
              Star a token on any card, Scope row or token view, or add one above by its address or ticker. Up
              to {cap}.
            </span>
          </div>
        )
      ) : (
        <ol className="wlm-list">
          {items.map((item, i) => {
            const name = watchLabel(item);
            const since = item.changeSinceAddedPct;
            const hour = hourChange(item, now);
            const day = dayChange(item, now);
            return (
              <li key={item.tokenId} className="wlm-row">
                <span className="wlm-rank num" aria-hidden>
                  {i + 1}
                </span>
                <button
                  type="button"
                  className="wlm-token"
                  onClick={() => open(item)}
                  title={`${name}: open the token's chart and details`}
                >
                  <TokenImage
                    url={item.imageUrl}
                    mint={item.mint}
                    size={64}
                    width={30}
                    height={30}
                    className="wlm-avatar"
                    fallback={
                      <span className="wlm-avatar placeholder">{name.replace("$", "").slice(0, 2)}</span>
                    }
                  />
                  <span className="wlm-names">
                    <strong>{name}</strong>
                    <span className="faint small">
                      {item.name && item.symbol ? `${item.name} · ` : ""}added {ago(item.addedAt, now)} ago
                    </span>
                  </span>
                </button>
                <span className="wlm-fig wlm-fig-mc">
                  <span className="wlm-fig-label">Mcap</span>
                  <span
                    className={`num${isStale(item, now) ? " stale" : ""}`}
                    title={item.at ? `Read ${ago(item.at, now)} ago` : "No reading yet"}
                  >
                    {usd(item.marketCapUsd)}
                  </span>
                </span>
                <span className="wlm-fig wlm-fig-since">
                  <span className="wlm-fig-label">Since added</span>
                  <span className={`num ${changeTone(since)}`}>
                    {since === null ? "–" : signedPct(since, 1)}
                  </span>
                </span>
                <span className="wlm-fig wlm-fig-h1">
                  <span className="wlm-fig-label">1h</span>
                  <span className={`num ${changeTone(hour)}`}>
                    {hour === null ? "–" : signedPct(hour, 1)}
                  </span>
                </span>
                <span className="wlm-fig wlm-fig-h24">
                  <span className="wlm-fig-label">24h</span>
                  <span className={`num ${changeTone(day)}`}>{day === null ? "–" : signedPct(day, 1)}</span>
                </span>
                <span className="wlm-actions">
                  <button
                    type="button"
                    className="wlm-icon wlm-up"
                    disabled={i === 0}
                    onClick={() => moveWatched(item.tokenId, -1)}
                    aria-label={`Move ${name} up`}
                    title="Move up"
                  >
                    <ChevronDownIcon size={14} />
                  </button>
                  <button
                    type="button"
                    className="wlm-icon"
                    disabled={i === items.length - 1}
                    onClick={() => moveWatched(item.tokenId, 1)}
                    aria-label={`Move ${name} down`}
                    title="Move down"
                  >
                    <ChevronDownIcon size={14} />
                  </button>
                  <button
                    type="button"
                    className="wlm-icon wlm-remove"
                    onClick={() => void unwatchToken(item.tokenId)}
                    aria-label={`Remove ${name} from your watchlist`}
                    title="Remove"
                  >
                    <CloseIcon size={14} />
                  </button>
                </span>
              </li>
            );
          })}
        </ol>
      )}

      {items.length > 0 && (
        <footer className="wlm-foot">
          <span className="faint small">
            Market caps from the scanner&apos;s own readings, refreshed every 30 seconds.
          </span>
          {confirmClear ? (
            <span className="wlm-confirm">
              <span className="small">Remove all {items.length}?</span>
              <button
                type="button"
                className="small danger"
                onClick={() => {
                  setConfirmClear(false);
                  void clearWatchlist();
                }}
              >
                Clear
              </button>
              <button type="button" className="small ghost" onClick={() => setConfirmClear(false)}>
                Cancel
              </button>
            </span>
          ) : (
            <button type="button" className="small ghost wlm-clear" onClick={() => setConfirmClear(true)}>
              <TrashIcon size={13} /> Clear all
            </button>
          )}
        </footer>
      )}
    </div>
  );
}

/** Add by contract address (straight away) or ticker/name (the tracked-token search). */
function WatchlistAdd({ full, cap, watched }: { full: boolean; cap: number; watched: WatchlistItem[] }) {
  const [text, setText] = useState("");
  const [found, setFound] = useState<Found>({ state: "idle" });
  const [adding, setAdding] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const listId = useId();
  const query = parseSearch(text);
  const param = query.kind === "text" ? searchParam(query) : "";
  const watchedMints = new Set(watched.map((w) => w.mint));

  useEffect(() => {
    if (!param) {
      setFound({ state: "idle" });
      return;
    }
    let live = true;
    setFound({ state: "loading" });
    const t = window.setTimeout(() => {
      api<TokenSearchAnswer>(`/tokens/search?${param}`)
        .then((a) => live && setFound({ state: "done", hits: a.hits.slice(0, SEARCH_HITS) }))
        .catch(
          (e: unknown) =>
            live && setFound({ state: "error", message: e instanceof Error ? e.message : String(e) }),
        );
    }, SEARCH_DELAY_MS);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [param]);

  const add = async (mint: string) => {
    if (adding) return;
    setAdding(mint);
    setMessage(null);
    const err = await watchMint(mint);
    setAdding(null);
    if (err) setMessage(err);
    else {
      setText("");
      setMessage(null);
    }
  };

  return (
    <div className="wlm-add">
      <form
        className="wlm-search"
        onSubmit={(e) => {
          e.preventDefault();
          if (query.kind === "mint") void add(query.mint);
          else if (found.state === "done" && found.hits[0]) void add(found.hits[0].mint);
        }}
      >
        <SearchIcon size={14} className="wlm-search-icon" />
        <input
          type="search"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={full ? fullText(cap) : "Add by contract address or ticker"}
          aria-label="Add a token by contract address or ticker"
          aria-controls={listId}
          disabled={full}
          spellCheck={false}
          autoComplete="off"
        />
        {query.kind === "mint" && (
          <button type="submit" className="primary small" disabled={full || adding !== null}>
            {adding ? <Spinner size={10} /> : <PlusIcon size={12} />} Add
          </button>
        )}
      </form>
      {message && (
        <p className="wlm-add-msg" role="alert">
          {message}
        </p>
      )}
      {query.kind === "text" && (
        <ul id={listId} className="wlm-hits" aria-live="polite">
          {found.state === "loading" && (
            <li className="wlm-hit-note faint small">
              <Spinner size={10} /> Searching…
            </li>
          )}
          {found.state === "error" && <li className="wlm-hit-note small down">{found.message}</li>}
          {found.state === "done" && found.hits.length === 0 && (
            <li className="wlm-hit-note faint small">
              No tracked token matches. Paste its contract address.
            </li>
          )}
          {found.state === "done" &&
            found.hits.map((h) => {
              const label = watchLabel({ symbol: h.symbol, name: h.name, mint: h.mint });
              const already = watchedMints.has(h.mint);
              return (
                <li key={h.mint} className="wlm-hit">
                  <TokenImage
                    url={h.imageUrl}
                    mint={h.mint}
                    size={48}
                    width={22}
                    height={22}
                    className="watchlist-avatar"
                    fallback={
                      <span className="watchlist-avatar placeholder">
                        {label.replace("$", "").slice(0, 2)}
                      </span>
                    }
                  />
                  <span className="wlm-hit-names">
                    <strong>{label}</strong>
                    <span className="faint small">{h.name && h.symbol ? h.name : shortAddress(h.mint)}</span>
                  </span>
                  <span className="num small">{usd(h.marketCapUsd)}</span>
                  <button
                    type="button"
                    className="small"
                    disabled={already || full || adding !== null}
                    onClick={() => void add(h.mint)}
                    title={already ? "Already watched" : full ? fullText(cap) : `Add ${label}`}
                  >
                    {already ? (
                      <>
                        <StarIcon size={12} /> Watched
                      </>
                    ) : adding === h.mint ? (
                      <Spinner size={10} />
                    ) : (
                      <>
                        <PlusIcon size={12} /> Add
                      </>
                    )}
                  </button>
                </li>
              );
            })}
        </ul>
      )}
    </div>
  );
}

/** The full Watchlist in a dialog: the market bar's "+N" (a centered panel; a sheet on phones). */
export function WatchlistDialog({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className="about-modal sheet-modal watchlist-modal"
      aria-labelledby="watchlist-dialog-title"
      onClose={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="about-body">
        <header className="about-head">
          <h2 id="watchlist-dialog-title" className="watchlist-dialog-title">
            <StarIcon size={16} className="watchlist-title-icon" /> Watchlist
          </h2>
          <button className="ghost icon-btn" onClick={onClose} aria-label="Close">
            <CloseIcon size={16} />
          </button>
        </header>
        <WatchlistManager compact onOpened={onClose} />
      </div>
    </dialog>
  );
}
