import { formatTokens } from "../burn";
import { compactSol, compactTokens, useWalletBalance } from "../walletBalance";

/**
 * The signed-in wallet's SOL and $ASDFASDFA beside the header's wallet pill (user ask 2026-10-19),
 * from the reading Settings and Portfolio share (walletBalance.ts), so it costs no extra reads.
 * Nothing shows until the first reading lands; a failed refresh keeps the last one, dimmed.
 */
export function HeaderBalances() {
  const { balance, error } = useWalletBalance();
  if (!balance) return null;
  const sol = balance.solLamports != null ? compactSol(balance.solLamports) : "–";
  const asdf = compactTokens(balance.totalRaw, balance.decimals);
  const full = `${balance.solLamports != null ? `${(Number(balance.solLamports) / 1e9).toLocaleString("en-US", { maximumFractionDigits: 9 })} SOL` : "SOL unavailable"} · ${formatTokens(BigInt(balance.totalRaw), balance.decimals)} $ASDFASDFA${error ? " (couldn't refresh)" : ""}`;
  return (
    <div className={`header-balances num${error ? " stale" : ""}`} title={full}>
      <span>
        {sol} <small>SOL</small>
      </span>
      <span>
        {asdf} <small>ASDF</small>
      </span>
    </div>
  );
}
