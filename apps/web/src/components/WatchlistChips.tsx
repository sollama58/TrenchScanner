import { useState } from "react";
import { signedPct, usd } from "../format";
import { useWatchlist, type WatchlistItem } from "../watchlist";
import { changeTone, dayChange, openWatched, watchLabel } from "../watchlistView";
import { PlusIcon, StarIcon } from "./Icons";
import { FitRow } from "./MarketBar";
import { TokenImage } from "./TokenImage";
import { WatchlistDialog } from "./WatchlistManager";

/**
 * The watched tokens side by side as small chips (image, $TICKER, market cap, the scan's 24h
 * change): the thin market bar's watchlist slot. With `fit` (the default) it shows only the chips
 * that fit its width whole, never wrapping (the bar's FitRow), then a "+N" button for the rest
 * ("+" when all fit); `max` caps the chips whatever the width. The button calls `onMore`, else
 * opens the Watchlist dialog. A chip opens its token's view. Renders nothing for a reader without
 * a watchlist.
 *
 *   <MarketBar left={<WatchlistPanel fit />} leftMini={<WatchlistChips />} />
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
  const [now] = useState(() => Date.now());
  if (status === "off") return null;
  const list = max !== undefined ? items.slice(0, Math.max(0, max)) : items;
  const capped = items.length - list.length;
  const open = () => (onMore ? onMore() : setDialog(true));
  const more = (hidden: number) => {
    const n = hidden + capped;
    return (
      <button
        type="button"
        className={`mkt-more${n > 0 ? " has" : ""}`}
        onClick={open}
        title={n > 0 ? `See all ${items.length} watched tokens` : "Open your watchlist"}
        aria-label={n > 0 ? `${n} more watched tokens` : "Open your watchlist"}
      >
        <PlusIcon size={12} />
        {n > 0 && <span className="num">{n}</span>}
      </button>
    );
  };
  const chips = list.map((item) => <Chip key={item.tokenId} item={item} now={now} />);

  return (
    <div className={`wl-chips${className ? ` ${className}` : ""}`} aria-label="Watchlist">
      {list.length === 0 ? (
        <>
          <span className="wl-chips-empty faint">
            <StarIcon size={12} /> No watched tokens
          </span>
          {more(0)}
        </>
      ) : fit ? (
        <FitRow more={more}>{chips}</FitRow>
      ) : (
        <>
          {chips}
          {more(0)}
        </>
      )}
      {!onMore && dialog && <WatchlistDialog onClose={() => setDialog(false)} />}
    </div>
  );
}

function Chip({ item, now }: { item: WatchlistItem; now: number }) {
  const name = watchLabel(item);
  const day = dayChange(item, now);
  return (
    <button
      type="button"
      className="mkt-mini-chip wl-chip"
      onClick={() => void openWatched(item).catch(() => undefined)}
      title={`${name}${item.name && item.symbol ? ` · ${item.name}` : ""}: market cap ${usd(item.marketCapUsd)}${day !== null ? `, 24h ${signedPct(day, 1)}` : ""}`}
    >
      <TokenImage
        url={item.imageUrl}
        size={40}
        width={20}
        height={20}
        className="avatar mkt-mini-img"
        fallback={
          <span className="avatar mkt-mini-img placeholder">{name.replace("$", "").slice(0, 1)}</span>
        }
      />
      <span className="wl-chip-sym">{name}</span>
      <span className="num wl-chip-mc">{usd(item.marketCapUsd)}</span>
      {day !== null && <span className={`num wl-chip-chg ${changeTone(day)}`}>{signedPct(day, 0)}</span>}
    </button>
  );
}
