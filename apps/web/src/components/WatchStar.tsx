import { toggleWatch, useWatchStar, type WatchToken } from "../watchlist";
import { StarIcon } from "./Icons";

/**
 * The Watchlist star (user ask 2026-10-23), beside the search button on alert cards and Scope rows
 * and in the token view's header: gold and filled while the token is watched. Hidden for a reader
 * without a watchlist (a guest, or no access). Its clicks stay its own, so it never opens the card.
 */
export function WatchStar({
  token,
  className,
  size = 13,
}: {
  token: WatchToken;
  className?: string;
  size?: number;
}) {
  const { watched, available } = useWatchStar(token.tokenId);
  if (!available) return null;
  const shown = token.symbol?.trim()
    ? `$${token.symbol.trim().replace(/^\$+/, "")}`
    : token.name?.trim() || "this token";
  const label = watched ? `Remove ${shown} from your watchlist` : `Add ${shown} to your watchlist`;
  return (
    <button
      type="button"
      className={`watch-star${watched ? " on" : ""}${className ? ` ${className}` : ""}`}
      aria-pressed={watched}
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        toggleWatch(token);
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <StarIcon size={size} />
    </button>
  );
}
