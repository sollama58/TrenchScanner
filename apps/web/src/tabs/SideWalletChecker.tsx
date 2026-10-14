import { useEffect, useState } from "react";
import { api } from "../api";
import { usePolling } from "../hooks";
import { ago, shortAddress } from "../format";
import { openWallet } from "../walletModal";
import { Skeleton } from "../components/Charts";
import { ChevronDownIcon, UsersIcon } from "../components/Icons";

export const SIDE_WINDOWS = ["24h", "7d", "30d"] as const;
export type SideWindow = (typeof SIDE_WINDOWS)[number];

/** Mirrors apps/api/src/routes/utilities.ts GET /utilities/side-wallets. */
interface SideLeaderboard {
  computedAt: string | null;
  gapMinutes: number;
  minShared: number;
  kols: {
    wallet: string;
    name: string | null;
    twitter: string | null;
    coins: Record<SideWindow, number>;
    sides: Record<SideWindow, number>;
  }[];
}

/** Mirrors apps/api/src/routes/utilities.ts GET /utilities/side-wallets/:wallet. */
export interface SideWallet {
  wallet: string;
  shared: number;
  pct: number;
  coins: number;
  gapSec: number;
  risk: { score: number; dumper: boolean; winner: boolean; sniper: boolean } | null;
}
interface KolSides {
  wallet: string;
  coins: Record<SideWindow, number>;
  sides: Record<SideWindow, SideWallet[]>;
}

/** Rows shown before "Show all". */
const FIRST_ROWS = 25;

const plural = (n: number, one: string) => `${n.toLocaleString("en-US")} ${one}${n === 1 ? "" : "s"}`;

/** "12s after", "2m 5s before", "same second". Exported for tests. */
export function gapText(sec: number): string {
  const s = Math.round(Math.abs(sec));
  if (s === 0) return "same second";
  const text = s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60 ? ` ${s % 60}s` : ""}`;
  return `${text} ${sec < 0 ? "before" : "after"}`;
}

/**
 * The Side Wallet Checker, free on the Utilities tab: the KOLs we track, ranked by how many of
 * our coins they bought in the last 30 days. Opening one lists the ten wallets that bought the
 * most of the same coins within a few minutes of it, sorted by % shared in the period picked.
 */
export function SideWalletChecker() {
  const { data, error } = usePolling<SideLeaderboard>("/utilities/side-wallets", 600_000);
  const [open, setOpen] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const [period, setPeriod] = useState<SideWindow>("30d");
  const kols = data?.kols ?? [];
  const shown = all ? kols : kols.slice(0, FIRST_ROWS);

  return (
    <section className="panel util-side">
      <header className="section-head">
        <div>
          <span className="eyebrow">
            <UsersIcon size={13} /> Side Wallet Checker
          </span>
          <h2>Who trades alongside the KOLs</h2>
        </div>
        <span className="util-cost util-free">Free</span>
      </header>
      <p className="muted small">
        KOLs ranked by how many of our tracked coins they bought in the last 30 days. Open one to see the
        wallets that bought the same coins within {data?.gapMinutes ?? 5} minutes of it, by the share of the
        KOL&apos;s coins they were in. Other KOLs, exchanges and bots are left out.
      </p>
      {error && !data ? (
        <p className="error small">Couldn&apos;t load the KOLs: {error.message}</p>
      ) : !data ? (
        <Skeleton lines={4} />
      ) : kols.length === 0 ? (
        <p className="muted small">
          No KOL has bought a tracked coin in the last 30 days yet. The list rebuilds every hour.
        </p>
      ) : (
        <>
          <div className="side-head faint small" aria-hidden="true">
            <span>#</span>
            <span>KOL</span>
            <span className="num">24h</span>
            <span className="num">7d</span>
            <span className="num">30d</span>
            <span />
          </div>
          <ol className="side-list">
            {shown.map((k, i) => {
              const isOpen = open === k.wallet;
              return (
                <li key={k.wallet} className={isOpen ? "open" : undefined}>
                  <button
                    type="button"
                    className="side-row"
                    aria-expanded={isOpen}
                    onClick={() => setOpen(isOpen ? null : k.wallet)}
                  >
                    <span className="side-rank num">{i + 1}</span>
                    <span className="side-who">
                      <strong>{k.name ?? shortAddress(k.wallet)}</strong>
                      <span className="faint small num">
                        {k.twitter ? `@${k.twitter} · ` : ""}
                        {shortAddress(k.wallet)}
                      </span>
                    </span>
                    {SIDE_WINDOWS.map((w) => (
                      <span key={w} className={`num side-count${w === "30d" ? " main" : ""}`}>
                        {k.coins[w].toLocaleString("en-US")}
                      </span>
                    ))}
                    <ChevronDownIcon size={16} className="side-chevron" />
                  </button>
                  {isOpen && (
                    <SideWallets
                      kol={k.wallet}
                      kolName={k.name ?? shortAddress(k.wallet)}
                      period={period}
                      setPeriod={setPeriod}
                      minShared={data.minShared}
                    />
                  )}
                </li>
              );
            })}
          </ol>
          <p className="faint small side-foot">
            {kols.length > FIRST_ROWS && (
              <>
                <button type="button" className="link" onClick={() => setAll((a) => !a)}>
                  {all ? "Show fewer" : `Show all ${kols.length} KOLs`}
                </button>
                {" · "}
              </>
            )}
            Counts are coins whose trades we read. Updated {ago(data.computedAt)}.
          </p>
        </>
      )}
    </section>
  );
}

/** One KOL's dropdown: its top ten side wallets in the period picked. */
function SideWallets({
  kol,
  kolName,
  period,
  setPeriod,
  minShared,
}: {
  kol: string;
  kolName: string;
  period: SideWindow;
  setPeriod: (w: SideWindow) => void;
  minShared: number;
}) {
  const [data, setData] = useState<KolSides | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api<KolSides>(`/utilities/side-wallets/${encodeURIComponent(kol)}`)
      .then((d) => live && setData(d))
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [kol]);

  const list = data?.sides[period] ?? [];
  const coins = data?.coins[period] ?? 0;
  return (
    <div className="side-drop">
      <div className="side-drop-head">
        <span className="small">Top wallets sharing {kolName}&apos;s trades, by % shared</span>
        <div className="segmented small" role="tablist" aria-label="Window">
          {SIDE_WINDOWS.map((w) => (
            <button
              key={w}
              type="button"
              role="tab"
              aria-selected={w === period}
              className={w === period ? "on" : ""}
              onClick={() => setPeriod(w)}
            >
              {w}
            </button>
          ))}
        </div>
      </div>
      {error ? (
        <p className="error small">Couldn&apos;t load its side wallets: {error}</p>
      ) : !data ? (
        <Skeleton lines={3} />
      ) : list.length === 0 ? (
        <p className="muted small">
          {coins === 0
            ? `No tracked coins in the last ${period}.`
            : `No wallet shared ${minShared} or more of its ${plural(coins, "coin")} in the last ${period}.`}
        </p>
      ) : (
        <ol className="side-sides">
          {list.map((s, i) => (
            <li key={s.wallet}>
              <span className="side-rank num faint">{i + 1}</span>
              <button
                type="button"
                className="link side-wallet num"
                title={`Open ${s.wallet}`}
                onClick={() => openWallet(s.wallet)}
              >
                {shortAddress(s.wallet)}
              </button>
              <span className="side-bar" aria-hidden="true">
                <span style={{ width: `${Math.min(100, s.pct)}%` }} />
              </span>
              <span className="side-pct num">{s.pct.toFixed(s.pct >= 10 ? 0 : 1)}%</span>
              <span className="side-meta faint small num">
                <span title="Coins it bought with the KOL, of the KOL's coins in the window">
                  {s.shared}/{coins} coins
                </span>
                <span title="Median time from the KOL's buy to its own">· {gapText(s.gapSec)}</span>
                <span title="Every tracked coin it bought in the window">· {s.coins} total</span>
              </span>
              <span className="side-tags">
                {s.risk?.winner && <span className="pill side-good">Winner</span>}
                {s.risk?.dumper && <span className="pill pill-warn">Dumper</span>}
                {s.risk?.sniper && <span className="pill">Sniper</span>}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
