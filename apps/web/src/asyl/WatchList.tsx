import { ago } from "../format";
import type { WatchRow } from "./asylApi";
import { shortAddr } from "./graph";

const VERB: Record<WatchRow["events"][number]["kind"], string> = {
  funded: "Funded",
  bought: "Bought",
  deployed: "Deployed",
};

/**
 * The watchlist (user ask 2026-10-26): wallets the reader follows, and what each did lately from
 * TrenchScanner's reads. New since the last look is marked; anything named opens on the map.
 */
export function WatchList({
  rows,
  cap,
  busy,
  onOpenWallet,
  onOpenToken,
  onRemove,
  onSeen,
}: {
  rows: WatchRow[];
  cap: number;
  busy: boolean;
  onOpenWallet: (wallet: string) => void;
  onOpenToken: (mint: string) => void;
  onRemove: (wallet: string) => void;
  onSeen: (wallet: string | null) => void;
}) {
  const fresh = rows.reduce((n, r) => n + r.fresh, 0);
  if (rows.length === 0)
    return (
      <p className="asyl-muted">
        Watch a wallet from its panel (the Watch button) to see here when it funds a wallet, buys a coin or
        deploys one. Up to {cap} wallets, free.
      </p>
    );
  return (
    <div className="asyl-watch">
      <div className="asyl-watch-head">
        <span className="asyl-muted asyl-small">
          {rows.length} of {cap} watched · {fresh ? `${fresh} new` : "nothing new"}
        </span>
        {fresh > 0 && (
          <button className="asyl-link asyl-small" disabled={busy} onClick={() => onSeen(null)}>
            Mark all seen
          </button>
        )}
      </div>
      <ul className="asyl-watch-list">
        {rows.map((r) => {
          const seen = Date.parse(r.seenAt);
          return (
            <li key={r.wallet} className={r.fresh ? "fresh" : ""}>
              <div className="asyl-watch-wallet">
                <button
                  className="asyl-link"
                  onClick={() => onOpenWallet(r.wallet)}
                  title="Add it to the map"
                >
                  {r.name ?? shortAddr(r.wallet)}
                </button>
                {r.fresh > 0 && <span className="asyl-count">{r.fresh} new</span>}
                <button
                  className="asyl-icon-btn"
                  aria-label={`Stop watching ${r.name ?? r.wallet}`}
                  title="Stop watching"
                  onClick={() => onRemove(r.wallet)}
                >
                  ×
                </button>
              </div>
              {r.events.length === 0 ? (
                <p className="asyl-muted asyl-small">
                  Nothing in the last week of TrenchScanner&apos;s reads.
                </p>
              ) : (
                <ul className="asyl-watch-events">
                  {r.events.slice(0, 5).map((e) => (
                    <li key={`${e.kind}${e.target}`} className={Date.parse(e.at) > seen ? "new" : ""}>
                      <span>
                        {VERB[e.kind]}{" "}
                        <button
                          className="asyl-link"
                          onClick={() =>
                            e.kind === "funded" ? onOpenWallet(e.target) : onOpenToken(e.target)
                          }
                        >
                          {e.symbol ? `$${e.symbol}` : shortAddr(e.target)}
                        </button>
                        {e.sol !== null && e.sol > 0
                          ? ` · ${e.sol >= 10 ? e.sol.toFixed(0) : e.sol.toFixed(2)} SOL`
                          : ""}
                      </span>
                      <span className="asyl-muted">{ago(e.at)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
