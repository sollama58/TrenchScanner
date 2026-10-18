import { formatTokens } from "../burn";
import { ago } from "../format";
import type { WalletBalance } from "../walletBalance";

function solText(lamports: string): string {
  const sol = Number(lamports) / 1e9;
  return sol.toLocaleString("en-US", { maximumFractionDigits: sol >= 100 ? 2 : 4 });
}

/** One figure in the holdings row. `value` null: still loading. */
function Coin({
  name,
  value,
  note,
  tone,
}: {
  name: string;
  value: string | null;
  note?: string | null;
  tone?: "good";
}) {
  return (
    <div className={`sub-coin${tone ? ` ${tone}` : ""}`}>
      <span className="sub-coin-name">{name}</span>
      {value === null ? (
        <span className="sub-coin-value skeleton" aria-label="Loading" />
      ) : (
        <strong className="sub-coin-value num">{value}</strong>
      )}
      {note && <small className="muted">{note}</small>}
    </div>
  );
}

/**
 * The signed-in wallet's SOL, $ASDFASDFA and place among the top 250 $ASDFASDFA holders (user
 * asks 2026-10-18), from one GET /subscription/balance. In Settings' Subscription section and its
 * Privy wallet section. The rank is the holder scan's (proHolders.ts), which Pro Mode also follows.
 */
export function WalletHoldings({ funds, asdfNote }: { funds: WalletBalance; asdfNote?: string | null }) {
  const { balance, error } = funds;
  if (error && !balance)
    return (
      <p className="error small sub-coins-error">
        Couldn&apos;t read your balances: {error}{" "}
        <button type="button" className="link" onClick={funds.reload}>
          Try again
        </button>
      </p>
    );
  const holder = balance?.holder;
  const rank = !balance
    ? { value: null, note: null }
    : !holder || !holder.scannedAt
      ? { value: "–", note: "rank not available yet" }
      : holder.rank !== null
        ? {
            value: `#${holder.rank}`,
            note: `in the top ${holder.of}${holder.stale ? `, as of ${ago(holder.scannedAt)}` : ""}`,
          }
        : {
            value: "–",
            note: `not in the top ${holder.of}${holder.stale ? `, as of ${ago(holder.scannedAt)}` : ""}`,
          };
  return (
    <div className="sub-coins">
      <Coin
        name="SOL"
        value={balance ? (balance.solLamports != null ? solText(balance.solLamports) : "–") : null}
        note={balance && balance.solLamports == null ? "couldn't read it" : null}
      />
      <Coin
        name="$ASDFASDFA"
        value={balance ? formatTokens(BigInt(balance.totalRaw), balance.decimals) : null}
        note={asdfNote}
      />
      <Coin
        name="Top holder rank"
        value={rank.value}
        note={rank.note}
        tone={holder?.rank != null ? "good" : undefined}
      />
    </div>
  );
}
