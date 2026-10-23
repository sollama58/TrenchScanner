import { useLayoutEffect, useRef, useState } from "react";
import { signedPct, usd } from "../format";
import { useWatchlist, type WatchlistItem } from "../watchlist";
import { changeTone, dayChange, openWatched, watchLabel } from "../watchlistView";
import { PlusIcon, StarIcon } from "./Icons";
import { TokenImage } from "./TokenImage";
import { WatchlistDialog } from "./WatchlistManager";

/** The gap between chips (styles.css .wl-chips). */
const GAP_PX = 6;

/**
 * How many chips of `widths` fit in `avail` px on one line, with `more` px kept for the "+N"
 * button after them. At least one when there is any.
 */
export function chipsThatFit(widths: readonly number[], avail: number, more: number): number {
  let used = more;
  let n = 0;
  for (const w of widths) {
    const next = used + (n > 0 || more > 0 ? GAP_PX : 0) + w;
    if (next > avail) break;
    used = next;
    n++;
  }
  return widths.length === 0 ? 0 : Math.max(1, n);
}

/**
 * The watched tokens side by side as tiny chips (image, $TICKER, market cap, the scan's 24h
 * change): the market bar's collapsed form. With `fit` (the default) it shows only the chips that
 * fit its width on one line, never wrapping, then a "+N" button for the rest ("+" when all fit);
 * `max` caps the chips whatever the width. The button calls `onMore`, else opens the Watchlist
 * dialog. A chip opens its token's view. Renders nothing for a reader without a watchlist.
 *
 *   <WatchlistChips onMore={() => setWatchlistOpen(true)} />
 */
export function WatchlistChips({
  max,
  fit = true,
  onMore,
  className,
}: {
  max?: number;
  fit?: boolean;
  onMore?: () => void;
  className?: string;
}) {
  const { status, items } = useWatchlist();
  const [dialog, setDialog] = useState(false);
  const row = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const [shown, setShown] = useState<number | null>(null);
  const [now] = useState(() => Date.now());
  const list = max !== undefined ? items.slice(0, Math.max(0, max)) : items;
  const key = list.map((i) => `${i.tokenId}:${i.marketCapUsd}:${i.priceChange24hPct}`).join("|");

  useLayoutEffect(() => {
    const el = row.current;
    if (!fit || !el) {
      setShown(null);
      return;
    }
    const measure = () => {
      const chips = [...el.querySelectorAll<HTMLElement>(":scope > .wl-chip")];
      const widths = chips.map((c) => c.offsetWidth);
      const more = moreRef.current ? moreRef.current.offsetWidth : 0;
      setShown(chipsThatFit(widths, el.clientWidth, more));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [fit, key]);

  if (status === "off") return null;
  const visible = shown ?? list.length;
  const hidden = items.length - Math.min(visible, list.length);
  const more = () => (onMore ? onMore() : setDialog(true));

  return (
    <div className={`wl-chips${className ? ` ${className}` : ""}`} ref={row} aria-label="Watchlist">
      {list.length === 0 && (
        <span className="wl-chips-empty faint">
          <StarIcon size={12} /> No watched tokens
        </span>
      )}
      {list.map((item, i) => (
        <Chip key={item.tokenId} item={item} now={now} out={i >= visible} />
      ))}
      <button
        ref={moreRef}
        type="button"
        className="wl-chip-more"
        onClick={more}
        title={hidden > 0 ? `See all ${items.length} watched tokens` : "Open your watchlist"}
        aria-label={hidden > 0 ? `${hidden} more watched tokens` : "Open your watchlist"}
      >
        {hidden > 0 ? <span className="num">+{hidden}</span> : <PlusIcon size={12} />}
      </button>
      {!onMore && dialog && <WatchlistDialog onClose={() => setDialog(false)} />}
    </div>
  );
}

function Chip({ item, now, out }: { item: WatchlistItem; now: number; out: boolean }) {
  const name = watchLabel(item);
  const day = dayChange(item, now);
  return (
    <button
      type="button"
      className={`wl-chip${out ? " is-out" : ""}`}
      tabIndex={out ? -1 : undefined}
      aria-hidden={out || undefined}
      onClick={() => void openWatched(item).catch(() => undefined)}
      title={`${name}${item.name && item.symbol ? ` · ${item.name}` : ""}: market cap ${usd(item.marketCapUsd)}${day !== null ? `, 24h ${signedPct(day, 1)}` : ""}`}
    >
      <TokenImage
        url={item.imageUrl}
        size={40}
        width={20}
        height={20}
        className="wl-chip-img"
        fallback={<span className="wl-chip-img placeholder">{name.replace("$", "").slice(0, 1)}</span>}
      />
      <span className="wl-chip-sym">{name}</span>
      <span className="num wl-chip-mc">{usd(item.marketCapUsd)}</span>
      {day !== null && <span className={`num wl-chip-chg ${changeTone(day)}`}>{signedPct(day, 0)}</span>}
    </button>
  );
}
