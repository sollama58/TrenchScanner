import { useEffect, useState } from "react";
import { api } from "../api";
import { shortAddress, tokenThumb } from "../format";
import { openWallet } from "../walletModal";
import { Skeleton } from "../components/Charts";
import { ExternalIcon, LinkIcon } from "../components/Icons";

type SideWindow = "24h" | "7d" | "30d";

/** Mirrors SideMatchLeg in apps/api/src/routes/utilities.ts. */
interface Leg {
  firstBuyAt: string;
  firstSellAt: string | null;
  buys: number;
  sells: number;
  solIn: number;
  solOut: number;
  boughtPct: number | null;
  firstBuyerRank: number | null;
  launchSniper: boolean;
  fastExit: boolean;
}

interface Funding {
  status: string;
  funder: string | null;
  exchange: string | null;
  amountSol: number | null;
  fundedAt: string | null;
}

/** Mirrors GET /utilities/side-wallets/:wallet/:side. */
export interface SideMatchData {
  kol: { wallet: string; name: string | null; funding: Funding | null };
  side: { wallet: string; funding: Funding | null };
  window: SideWindow;
  gapMinutes: number;
  kolCoins: number;
  fundingLink: "same-funder" | "kol-funded-wallet" | "wallet-funded-kol" | "exchange" | null;
  summary: {
    shared: number;
    medianGapSec: number | null;
    before: number;
    sameSecond: number;
    after: number;
    bothSold: number;
    exitedTogether: number;
    medianSellGapSec: number | null;
    medianSizeRatio: number | null;
    kolSolIn: number;
    sideSolIn: number;
    kolPnlSol: number;
    sidePnlSol: number;
  };
  trades: {
    mint: string;
    symbol: string | null;
    name: string | null;
    imageUrl: string | null;
    kol: Leg;
    side: Leg;
    gapSec: number;
    sellGapSec: number | null;
  }[];
  truncated: boolean;
}

/** "12s", "2m 5s", "1h 4m": a duration in words. Exported for tests. */
export function span(sec: number): string {
  const s = Math.round(Math.abs(sec));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60 ? ` ${s % 60}s` : ""}`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}h${m ? ` ${m}m` : ""}`;
}

/** "12s after", "3s before", "same second". */
const offset = (sec: number) =>
  Math.abs(sec) <= 1 ? "same second" : `${span(sec)} ${sec < 0 ? "before" : "after"}`;

const sol = (n: number) => `${n.toLocaleString("en-US", { maximumFractionDigits: n >= 10 ? 1 : 2 })} SOL`;
const signedSol = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${sol(Math.abs(n))}`;

const when = (iso: string) =>
  new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

/** What the two wallets' funders say, as a headline and a tone. Exported for tests. */
export function fundingVerdict(d: Pick<SideMatchData, "fundingLink" | "kol" | "side">): {
  text: string;
  tone: "strong" | "weak" | "none";
} {
  switch (d.fundingLink) {
    case "same-funder":
      return { text: "Same funder", tone: "strong" };
    case "kol-funded-wallet":
      return { text: "The KOL funded this wallet", tone: "strong" };
    case "wallet-funded-kol":
      return { text: "This wallet funded the KOL", tone: "strong" };
    case "exchange":
      return { text: "Both funded from one exchange", tone: "weak" };
  }
  const read = (f: Funding | null) => f && (f.status === "found" || f.status === "none");
  if (read(d.kol.funding) && read(d.side.funding)) return { text: "Different funders", tone: "none" };
  return { text: "Funders not read yet", tone: "none" };
}

function FunderLine({ who, f, onOpen }: { who: string; f: Funding | null; onOpen?: () => void }) {
  let body: React.ReactNode;
  if (!f) body = <span className="faint">not read yet</span>;
  else if (!f.funder)
    body = <span className="faint">{f.status === "none" ? "no one else paid in" : "unknown"}</span>;
  else
    body = (
      <>
        <button
          type="button"
          className="link num"
          title={`Open ${f.funder}`}
          onClick={() => {
            onOpen?.();
            openWallet(f.funder!);
          }}
        >
          {f.exchange ?? shortAddress(f.funder)}
        </button>
        {f.amountSol != null && <span className="faint num"> · {sol(f.amountSol)}</span>}
        {f.fundedAt && <span className="faint"> · {when(f.fundedAt)}</span>}
      </>
    );
  return (
    <div className="sm-funder small">
      <span className="faint">{who} funded by</span> {body}
    </div>
  );
}

/** A leg's launch roles and exit speed, as short tags. */
function roles(l: Leg): string[] {
  const out: string[] = [];
  if (l.launchSniper) out.push("Sniper");
  else if (l.firstBuyerRank) out.push(`Buyer #${l.firstBuyerRank}`);
  if (l.fastExit) out.push("Fast exit");
  return out;
}

/**
 * One KOL and one listed wallet, coin by coin (user ask 2026-10-14): the funding tie, the buy
 * order and timing, exits and sizes, then every shared coin's two legs side by side, so a person
 * can judge for themselves whether the wallets are linked.
 */
export function SideMatch({
  kol,
  kolName,
  side,
  period,
  onOpen,
}: {
  kol: string;
  kolName: string;
  side: string;
  period: SideWindow;
  /** Called before a wallet modal opens (a dialog this sits in closes first). */
  onOpen?: () => void;
}) {
  const [data, setData] = useState<SideMatchData | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setData(null);
    setError(null);
    api<SideMatchData>(
      `/utilities/side-wallets/${encodeURIComponent(kol)}/${encodeURIComponent(side)}?window=${period}`,
    )
      .then((d) => live && setData(d))
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [kol, side, period]);

  if (error) return <p className="error small sm-body">Couldn&apos;t load the shared trades: {error}</p>;
  if (!data)
    return (
      <div className="sm-body">
        <Skeleton lines={3} />
      </div>
    );
  const s = data.summary;
  const verdict = fundingVerdict(data);
  return (
    <div className="sm-body">
      <div className="sm-signals">
        <div className={`sm-signal sm-funding ${verdict.tone}`}>
          <span className="sm-label">Funding</span>
          <strong>
            {verdict.tone === "strong" && <LinkIcon size={13} />} {verdict.text}
          </strong>
          <FunderLine who={kolName} f={data.kol.funding} onOpen={onOpen} />
          <FunderLine who="Wallet" f={data.side.funding} onOpen={onOpen} />
        </div>
        <div className="sm-signal">
          <span className="sm-label">Buy order</span>
          <strong className="num">{s.medianGapSec == null ? "—" : `Median ${offset(s.medianGapSec)}`}</strong>
          <span className="small faint num">
            Before {s.before} · same second {s.sameSecond} · after {s.after}
          </span>
        </div>
        <div className="sm-signal">
          <span className="sm-label">Exits</span>
          <strong className="num">
            {s.bothSold === 0 ? "No shared exits" : `${s.exitedTogether} of ${s.bothSold} together`}
          </strong>
          <span className="small faint num">
            {s.medianSellGapSec == null
              ? "First sells within 5 minutes count as together"
              : `Median first sell ${offset(s.medianSellGapSec)} the KOL's`}
          </span>
        </div>
        <div className="sm-signal">
          <span className="sm-label">Size</span>
          <strong className="num">
            {s.medianSizeRatio == null
              ? "—"
              : `${s.medianSizeRatio.toLocaleString("en-US", { maximumFractionDigits: 2 })}× the KOL's buy`}
          </strong>
          <span className="small faint num">
            {sol(s.sideSolIn)} vs {sol(s.kolSolIn)} in · P&amp;L{" "}
            <span className={s.sidePnlSol >= 0 ? "up" : "down"}>{signedSol(s.sidePnlSol)}</span> vs{" "}
            <span className={s.kolPnlSol >= 0 ? "up" : "down"}>{signedSol(s.kolPnlSol)}</span>
          </span>
        </div>
      </div>
      <details className="sm-hint small">
        <summary>What points to one owner?</summary>
        <ul>
          <li>
            <strong>A shared funder</strong> (not an exchange), or one wallet funding the other, is the
            strongest sign.
          </li>
          <li>
            <strong>Buying before the KOL</strong>, or mixed order, fits one person on two wallets. Always a
            few seconds after fits a copy-trade bot.
          </li>
          <li>
            <strong>Selling together</strong> and steady sizing (the same fraction of the KOL&apos;s buy) fit
            one person splitting a position.
          </li>
          <li>Launch snipes and fast exits on both legs point to a bot rather than a person.</li>
        </ul>
      </details>
      <p className="faint small sm-caption">
        {data.trades.length} of the KOL&apos;s {data.kolCoins} coins in the last {data.window} where both
        first bought within {data.gapMinutes} minutes, newest first{data.truncated ? " (the newest 200)" : ""}
        .
      </p>
      <div className="sm-table" role="table" aria-label={`Coins ${kolName} and this wallet bought together`}>
        <div className="sm-row sm-headrow faint small" role="row">
          <span role="columnheader">Coin</span>
          <span role="columnheader">Bought</span>
          <span role="columnheader" className="num">
            SOL in
          </span>
          <span role="columnheader">First sell</span>
          <span role="columnheader" className="num">
            P&amp;L
          </span>
        </div>
        {data.trades.map((t) => {
          const kRoles = roles(t.kol);
          const sRoles = roles(t.side);
          return (
            <div key={t.mint} className="sm-row" role="row">
              <span className="sm-coin" role="cell">
                {t.imageUrl ? (
                  <img src={tokenThumb(t.imageUrl, 48)} alt="" width={24} height={24} loading="lazy" />
                ) : (
                  <span className="sm-coin-dot" aria-hidden="true" />
                )}
                <span className="sm-coin-text">
                  <a
                    href={`https://dexscreener.com/solana/${t.mint}`}
                    target="_blank"
                    rel="noreferrer"
                    title={`${t.name ?? t.mint} on DexScreener`}
                  >
                    {t.symbol ? `$${t.symbol}` : shortAddress(t.mint)} <ExternalIcon size={11} />
                  </a>
                  <span className="faint small">{when(t.kol.firstBuyAt)}</span>
                </span>
              </span>
              <span className="sm-legs" role="cell" data-label="Bought">
                <span className="faint">KOL</span>
                <span className="num">
                  {new Date(t.kol.firstBuyAt).toLocaleTimeString("en-US", { hour12: false })}
                </span>
                <span className="faint">Wallet</span>
                <span className={`num sm-gap ${t.gapSec < -1 ? "before" : ""}`}>{offset(t.gapSec)}</span>
              </span>
              <span className="sm-legs num" role="cell" data-label="SOL in">
                <span className="faint">KOL</span>
                <span>
                  {sol(t.kol.solIn)}
                  {t.kol.buys > 1 && <span className="faint"> · {t.kol.buys} buys</span>}
                </span>
                <span className="faint">Wallet</span>
                <span>
                  {sol(t.side.solIn)}
                  {t.side.buys > 1 && <span className="faint"> · {t.side.buys} buys</span>}
                </span>
              </span>
              <span className="sm-legs" role="cell" data-label="First sell">
                <span className="faint">KOL</span>
                <span className="num">
                  {t.kol.firstSellAt
                    ? `${span((Date.parse(t.kol.firstSellAt) - Date.parse(t.kol.firstBuyAt)) / 1000)} held`
                    : "holding"}
                </span>
                <span className="faint">Wallet</span>
                <span className="num">
                  {t.sellGapSec != null ? (
                    <span className={Math.abs(t.sellGapSec) <= 300 ? "sm-together" : undefined}>
                      sold {offset(t.sellGapSec)}
                    </span>
                  ) : t.side.firstSellAt ? (
                    `${span((Date.parse(t.side.firstSellAt) - Date.parse(t.side.firstBuyAt)) / 1000)} held`
                  ) : (
                    "holding"
                  )}
                </span>
              </span>
              <span className="sm-legs num sm-pnl" role="cell" data-label="P&L">
                <span className="faint">KOL</span>
                <span className={t.kol.solOut - t.kol.solIn >= 0 ? "up" : "down"}>
                  {signedSol(t.kol.solOut - t.kol.solIn)}
                </span>
                <span className="faint">Wallet</span>
                <span className={t.side.solOut - t.side.solIn >= 0 ? "up" : "down"}>
                  {signedSol(t.side.solOut - t.side.solIn)}
                </span>
              </span>
              {(kRoles.length > 0 || sRoles.length > 0) && (
                <span className="sm-roles small" role="cell">
                  {kRoles.map((r) => (
                    <span key={`k${r}`} className="pill">
                      KOL · {r}
                    </span>
                  ))}
                  {sRoles.map((r) => (
                    <span key={`s${r}`} className="pill">
                      Wallet · {r}
                    </span>
                  ))}
                </span>
              )}
            </div>
          );
        })}
      </div>
      <p className="faint small sm-caption">
        P&amp;L is SOL out minus SOL in on that coin from the trades we read; an open position shows only what
        it spent.
      </p>
    </div>
  );
}
