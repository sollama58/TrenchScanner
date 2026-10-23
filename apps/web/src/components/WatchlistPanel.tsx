import { Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ago, signedPct, usd } from "../format";
import { useWatchlist, type WatchlistItem } from "../watchlist";
import { changeTone, hourChange, isStale, openWatched, watchLabel } from "../watchlistView";
import { CloseIcon, PlusIcon, StarIcon } from "./Icons";
import { Spinner } from "./Loading";
import { TokenImage } from "./TokenImage";
import { WatchlistDialog } from "../livePanels";

/** A row's height and the gap under it (styles.css .watchlist-row), and the "+N" button's. */
const ROW_PX = 33;
const MORE_PX = 28;

/** How many of `count` rows to show in `room` px with the "+N" button under them. */
export function rowsThatFit(count: number, room: number | null): number {
  if (room === null || room <= 0) return count;
  if (count * ROW_PX + MORE_PX <= room + 1) return count;
  return Math.min(count, Math.max(1, Math.floor((room + 1 - MORE_PX) / ROW_PX)));
}

/**
 * The Watchlist (user ask 2026-10-23): the tokens this account starred, each with its market cap
 * now, its change since it was starred and the scan's 1h change. Built for the left third of the
 * Live tab's market bar: it takes its parent's height (at most --watchlist-max-h, 170px by default).
 *
 * With `fit`, it shows only the rows that fit that height whole, then a "+N" button for the rest
 * (or "+" when all fit), which opens the full list (`onMore`, else its own Watchlist dialog).
 * Without it, the list scrolls. A row opens the token view; its x unstars it.
 *
 *   <MarketBar left={<WatchlistPanel fit />} />
 *   <div style={{ height: 180 }}><WatchlistPanel /></div>
 */
export function WatchlistPanel({
  className,
  fit = false,
  onMore,
}: {
  className?: string;
  fit?: boolean;
  onMore?: () => void;
}) {
  const { status, items, cap, notice, unwatch } = useWatchlist();
  const [now, setNow] = useState(() => Date.now());
  const [opening, setOpening] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const [dialog, setDialog] = useState(false);
  const listBox = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState<number | null>(null);
  const count = items.length;

  // "As of 5m ago" and the stale dimming move with the clock, not only with each poll.
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, []);
  useEffect(() => setNow(Date.now()), [items]);

  // How tall the list's box is, for `fit`.
  const hasRows = count > 0;
  useLayoutEffect(() => {
    const el = listBox.current;
    if (!fit || !el || typeof ResizeObserver === "undefined") return;
    const measure = () => setRoom(el.clientHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [fit, hasRows]);

  const open = async (item: WatchlistItem) => {
    if (opening) return;
    setOpening(item.tokenId);
    setOpenError(null);
    try {
      await openWatched(item);
    } catch (e) {
      setOpenError(
        `Couldn't open ${watchLabel(item)}${e instanceof Error && e.message ? `: ${e.message}` : ""}`,
      );
    } finally {
      setOpening(null);
    }
  };
  const more = () => (onMore ? onMore() : setDialog(true));

  const message = openError ?? notice;
  const shown = fit ? rowsThatFit(count, room) : count;
  const hidden = count - shown;

  return (
    <section
      className={`watchlist-panel${fit ? " fit" : ""}${className ? ` ${className}` : ""}`}
      aria-label="Watchlist"
    >
      <header className="watchlist-head">
        <h3 className="watchlist-title">
          <StarIcon size={12} className="watchlist-title-icon" />
          Watchlist
        </h3>
        {status !== "off" && (status === "ready" || count > 0) && (
          <span
            className={`pill watchlist-count num${count >= cap ? " full" : ""}`}
            title={count >= cap ? `Watchlist is full (${cap})` : `${count} of ${cap} tokens`}
          >
            {`${count}/${cap}`}
          </span>
        )}
        {(status === "loading" || status === "idle") && count === 0 && <Spinner size={10} />}
      </header>
      {message && (
        <p className="watchlist-notice" role="status">
          {message}
        </p>
      )}
      {status === "off" ? (
        <div className="watchlist-empty">
          <StarIcon size={16} />
          <span>Sign in with access to keep a watchlist</span>
        </div>
      ) : count === 0 ? (
        status === "loading" || status === "idle" ? (
          <ul className="watchlist-list" aria-busy="true">
            {[0, 1, 2].map((i) => (
              <li key={i} className="watchlist-row is-skel">
                <span className="skeleton round watchlist-avatar" />
                <span className="skeleton watchlist-skel-text" />
              </li>
            ))}
          </ul>
        ) : (
          <div className="watchlist-empty">
            <StarIcon size={16} />
            <span>
              {status === "error"
                ? "Couldn't load your watchlist"
                : "Star a token on any card to watch it here"}
            </span>
            {status !== "error" && (
              <button type="button" className="watchlist-empty-add" onClick={more}>
                <PlusIcon size={12} /> Add by address or ticker
              </button>
            )}
          </div>
        )
      ) : (
        <div className="watchlist-list-box" ref={listBox}>
          <ul className="watchlist-list">
            {items.slice(0, shown).map((item) => (
              <WatchRow
                key={item.tokenId}
                item={item}
                now={now}
                opening={opening === item.tokenId}
                onOpen={() => void open(item)}
                onRemove={() => unwatch(item.tokenId)}
              />
            ))}
          </ul>
          {fit && (
            <button
              type="button"
              className="watchlist-more"
              onClick={more}
              title={hidden > 0 ? `See all ${count} watched tokens` : "Manage your watchlist"}
              aria-label={
                hidden > 0 ? `${hidden} more: see all ${count} watched tokens` : "Manage your watchlist"
              }
            >
              {hidden > 0 ? (
                <span className="num">+{hidden} more</span>
              ) : (
                <>
                  <PlusIcon size={12} />
                  <span>{count < cap ? "Add or manage" : "Manage"}</span>
                </>
              )}
            </button>
          )}
        </div>
      )}
      {!onMore && dialog && (
        <Suspense fallback={null}>
          <WatchlistDialog onClose={() => setDialog(false)} />
        </Suspense>
      )}
    </section>
  );
}

function WatchRow({
  item,
  now,
  opening,
  onOpen,
  onRemove,
}: {
  item: WatchlistItem;
  now: number;
  opening: boolean;
  onOpen: () => void;
  onRemove: () => void;
}) {
  const name = watchLabel(item);
  const readAt = item.at ? Date.parse(item.at) : NaN;
  const stale = isStale(item, now);
  const hour = hourChange(item, now);
  const since = item.changeSinceAddedPct;
  const title = [
    item.name && item.symbol ? `${name} · ${item.name}` : name,
    item.marketCapUsd !== null
      ? `Market cap ${usd(item.marketCapUsd)}${Number.isFinite(readAt) ? `, read ${ago(item.at, now)} ago` : ""}`
      : "No market reading yet",
    item.addedMarketCapUsd !== null
      ? `Added ${ago(item.addedAt, now)} ago at ${usd(item.addedMarketCapUsd)}${since !== null ? ` (${signedPct(since, 1)} since)` : ""}`
      : `Added ${ago(item.addedAt, now)} ago`,
    hour !== null ? `1h ${signedPct(hour, 1)}` : null,
    "Open the token's chart and details",
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <li className={`watchlist-row${opening ? " opening" : ""}`}>
      <button type="button" className="watchlist-open" onClick={onOpen} title={title} aria-busy={opening}>
        <TokenImage
          url={item.imageUrl}
          mint={item.mint}
          size={48}
          className="watchlist-avatar"
          width={22}
          height={22}
          fallback={<span className="watchlist-avatar placeholder">{name.replace("$", "").slice(0, 2)}</span>}
        />
        <span className="watchlist-sym">{name}</span>
        <span className={`num watchlist-mc${stale ? " stale" : ""}`}>{usd(item.marketCapUsd)}</span>
        <span className="watchlist-changes">
          <span
            className={`num watchlist-chg ${changeTone(since)}`}
            aria-label={since === null ? "No change since added" : `${signedPct(since, 1)} since added`}
          >
            {since === null ? "–" : signedPct(since, Math.abs(since) < 10 ? 1 : 0)}
          </span>
          {hour !== null && (
            <span
              className={`num watchlist-hour ${changeTone(hour)}`}
              aria-label={`${signedPct(hour, 1)} in the last hour`}
            >
              1h {signedPct(hour, 0)}
            </span>
          )}
        </span>
      </button>
      <button
        type="button"
        className="watchlist-remove"
        onClick={onRemove}
        aria-label={`Remove ${name} from your watchlist`}
        title={`Remove ${name} from your watchlist`}
      >
        <CloseIcon size={12} />
      </button>
    </li>
  );
}
