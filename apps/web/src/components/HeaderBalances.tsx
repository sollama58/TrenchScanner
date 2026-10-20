import { formatTokens } from "../burn";
import { useCanSignTrades, useProState } from "../proTrade";
import {
  compactSol,
  compactTokens,
  headerPairText,
  spendBalancesShown,
  useWalletBalance,
} from "../walletBalance";

/**
 * The signed-in wallet's SOL and $ASDFASDFA beside the header's wallet pill (user ask 2026-10-19),
 * from the reading Settings and Portfolio share (walletBalance.ts). Shown for a wallet that can
 * trade here (Pro Mode, and a browser that can sign), on the same cadence as its position. Nothing
 * is read for anyone else. A missing first reading is a dash; a failed refresh keeps the last one,
 * dimmed.
 */
export function HeaderBalances() {
  const pro = useProState();
  const canSign = useCanSignTrades(pro?.wallet ?? null);
  const shown = spendBalancesShown(!!pro?.pro, canSign);
  const { balance, error } = useWalletBalance(shown, shown);
  if (!shown) return null;
  const sol = balance?.solLamports != null ? compactSol(balance.solLamports) : "–";
  const asdf = balance ? compactTokens(balance.totalRaw, balance.decimals) : "–";
  const solFull =
    balance?.solLamports != null
      ? `${(Number(balance.solLamports) / 1e9).toLocaleString("en-US", { maximumFractionDigits: 9 })} SOL`
      : "Your SOL balance is loading";
  const asdfFull = balance
    ? `${formatTokens(BigInt(balance.totalRaw), balance.decimals)} $ASDFASDFA`
    : "Your $ASDFASDFA balance is loading";
  const full = `${solFull} · ${asdfFull}${error ? " (last reading)" : ""}`;
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

/**
 * The open coin and the wallet's SOL, in the Pro token header. The position supplies the coin
 * (its own poll) and the shared wallet reading supplies SOL. Dashes until each read lands.
 */
export function TokenPairBalances({
  symbol,
  tokenRaw,
  decimals,
  solLamports,
  stale,
}: {
  symbol: string;
  tokenRaw: string | null;
  decimals: number | null;
  solLamports: string | null;
  stale: boolean;
}) {
  const { token, sol } = headerPairText({ tokenRaw, decimals, solLamports });
  const tokenFull =
    tokenRaw !== null && decimals !== null ? `${formatTokens(BigInt(tokenRaw), decimals)} ${symbol}` : null;
  const solFull =
    solLamports !== null
      ? `${(Number(solLamports) / 1e9).toLocaleString("en-US", { maximumFractionDigits: 9 })} SOL`
      : null;
  const title = `Your balance: ${tokenFull ?? `${symbol} is loading`} · ${solFull ?? "SOL is loading"}`;
  return (
    <div className={`tm-balances num${stale ? " stale" : ""}`} title={title} aria-label={title}>
      <span>
        {token} <small>{symbol}</small>
      </span>
      <span>
        {sol} <small>SOL</small>
      </span>
    </div>
  );
}
