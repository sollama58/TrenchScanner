import { useEffect, useState } from "react";
import { api, type Card } from "../api";
import { ago, signedPct, usd } from "../format";
import { openTokenModal } from "../tokenModal";
import { useWatchlist, type WatchlistItem } from "../watchlist";
import { CloseIcon, StarIcon } from "./Icons";
import { Spinner } from "./Loading";
import { TokenImage } from "./TokenImage";

/** A reading older than this shows dimmed, with its age in the tooltip. */
const STALE_MS = 30 * 60_000;
/** The scan's 1h change shows only while the snapshot it came from is this fresh. */
const HOUR_CHANGE_FRESH_MS = 20 * 60_000;

/**
 * The Watchlist (user ask 2026-10-23): the tokens this account starred, each with its market cap
 * now, its change since it was starred and the scan's 1h change. Built to fill the left third of
 * the Live tab's market bar: it takes its parent's height (at most --watchlist-max-h, 170px by
 * default) and scrolls past four or five rows. A row opens the token view; its x unstars it.
 *
 *   <WatchlistPanel />                      // standalone: up to 170px tall
 *   <div style={{ height: 180 }}><WatchlistPanel /></div>   // fills a fixed slot
 */
export function WatchlistPanel({ className }: { className?: string }) {
  const { status, items, cap, notice, unwatch } = useWatchlist();
  const [now, setNow] = useState(() => Date.now());
  const [opening, setOpening] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);

  // "As of 5m ago" and the stale dimming move with the clock, not only with each poll.
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, []);
  useEffect(() => setNow(Date.now()), [items]);

  const open = async (item: WatchlistItem) => {
    if (opening) return;
    setOpening(item.tokenId);
    setOpenError(null);
    try {
      const card = await api<Card>(`/tokens/${encodeURIComponent(item.mint)}/card`);
      openTokenModal(card, Date.now());
    } catch (e) {
      setOpenError(`Couldn't open ${label(item)}${e instanceof Error && e.message ? `: ${e.message}` : ""}`);
    } finally {
      setOpening(null);
    }
  };

  const message = openError ?? notice;
  const count = items.length;

  return (
    <section className={`watchlist-panel${className ? ` ${className}` : ""}`} aria-label="Watchlist">
      <header className="watchlist-head">
        <h3 className="watchlist-title">
          <StarIcon size={12} className="watchlist-title-icon" />
          Watchlist
        </h3>
        {status !== "off" && count > 0 && (
          <span className="pill watchlist-count num" title={`${count} of ${cap} tokens`}>
            {count}
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
          </div>
        )
      ) : (
        <ul className="watchlist-list">
          {items.map((item) => (
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
      )}
    </section>
  );
}

function label(item: Pick<WatchlistItem, "symbol" | "name" | "mint">): string {
  const sym = item.symbol?.trim().replace(/^\$+/, "");
  if (sym) return `$${sym}`;
  return item.name?.trim() || `${item.mint.slice(0, 4)}…${item.mint.slice(-4)}`;
}

function tone(v: number | null): string {
  if (v === null || Math.abs(v) < 0.5) return "flat";
  return v > 0 ? "up" : "down";
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
  const name = label(item);
  const readAt = item.at ? Date.parse(item.at) : NaN;
  const stale = Number.isFinite(readAt) && now - readAt > STALE_MS;
  const changeAt = item.changeAt ? Date.parse(item.changeAt) : NaN;
  const hour =
    item.priceChange1hPct !== null && Number.isFinite(changeAt) && now - changeAt <= HOUR_CHANGE_FRESH_MS
      ? item.priceChange1hPct
      : null;
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
            className={`num watchlist-chg ${tone(since)}`}
            aria-label={since === null ? "No change since added" : `${signedPct(since, 1)} since added`}
          >
            {since === null ? "–" : signedPct(since, Math.abs(since) < 10 ? 1 : 0)}
          </span>
          {hour !== null && (
            <span
              className={`num watchlist-hour ${tone(hour)}`}
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
