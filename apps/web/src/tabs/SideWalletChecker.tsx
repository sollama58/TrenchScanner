import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { usePolling } from "../hooks";
import { ago, shortAddress } from "../format";
import { openWallet } from "../walletModal";
import { Skeleton } from "../components/Charts";
import { ChevronDownIcon, CloseIcon, SearchIcon, UsersIcon } from "../components/Icons";

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
/** Side wallets shown in a dropdown; more open in a modal. */
const DROP_ROWS = 10;

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
 * our coins they bought in the last 30 days. Opening one lists the top wallets that bought the
 * most of the same coins within a few minutes of it, sorted by % shared in the period picked.
 */
export function SideWalletChecker() {
  const { data, error } = usePolling<SideLeaderboard>("/utilities/side-wallets", 600_000);
  const [open, setOpen] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const [period, setPeriod] = useState<SideWindow>("30d");
  const [query, setQuery] = useState("");
  const kols = data?.kols ?? [];
  const q = query.trim().toLowerCase().replace(/^@/, "");
  // A search shows every match, each at its own leaderboard rank.
  const matches = kols
    .map((k, i) => ({ k, rank: i + 1 }))
    .filter(({ k }) => !q || [k.name, k.twitter, k.wallet].some((v) => v?.toLowerCase().includes(q)));
  const shown = all || q ? matches : matches.slice(0, FIRST_ROWS);

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
      <p className="side-note small" role="note">
        These are possible side wallets, matched only by buying the same coins at about the same time. None is
        confirmed to belong to the KOL: a wallet here may be a copy trader, a friend, a bot or chance. Not
        financial advice.
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
          <label className="side-search">
            <SearchIcon size={14} />
            <input
              type="search"
              placeholder="Search KOLs by name, @handle or wallet"
              aria-label="Search KOLs"
              autoComplete="off"
              spellCheck={false}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <div className="side-head faint small" aria-hidden="true">
            <span>#</span>
            <span>KOL</span>
            <span className="num">24h</span>
            <span className="num">7d</span>
            <span className="num">30d</span>
            <span />
          </div>
          <ol className="side-list">
            {shown.map(({ k, rank }) => {
              const isOpen = open === k.wallet;
              return (
                <li key={k.wallet} className={isOpen ? "open" : undefined}>
                  <button
                    type="button"
                    className="side-row"
                    aria-expanded={isOpen}
                    onClick={() => setOpen(isOpen ? null : k.wallet)}
                  >
                    <span className="side-rank num">{rank}</span>
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
          {q && matches.length === 0 && (
            <p className="muted small side-none">No KOL matches “{query.trim()}”.</p>
          )}
          <p className="faint small side-foot">
            {!q && kols.length > FIRST_ROWS && (
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

/** One KOL's dropdown: its top ten side wallets in the period picked, and the rest in a modal. */
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
  const [showAll, setShowAll] = useState(false);
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
        <>
          <SideRows list={list.slice(0, DROP_ROWS)} coins={coins} />
          {list.length > DROP_ROWS && (
            <button type="button" className="ghost small-btn side-all" onClick={() => setShowAll(true)}>
              Show all {list.length} wallets
            </button>
          )}
        </>
      )}
      {showAll && (
        <SideWalletsModal
          kolName={kolName}
          period={period}
          list={list}
          coins={coins}
          onClose={() => setShowAll(false)}
        />
      )}
    </div>
  );
}

/** Every listed side wallet for one KOL and window, in a native modal (a sheet on phones). */
function SideWalletsModal({
  kolName,
  period,
  list,
  coins,
  onClose,
}: {
  kolName: string;
  period: SideWindow;
  list: SideWallet[];
  coins: number;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className="about-modal sheet-modal side-modal"
      aria-labelledby="side-modal-title"
      onClose={onClose}
      // A click on the backdrop lands on the dialog element itself; clicks inside land on its content.
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="about-body">
        <header className="about-head">
          <h2 id="side-modal-title">
            {kolName}&apos;s possible side wallets · {period}
          </h2>
          <button type="button" className="ghost icon-btn" onClick={onClose} aria-label="Close">
            <CloseIcon size={16} />
          </button>
        </header>
        <p className="muted small">
          All {list.length} wallets that shared at least two of its {plural(coins, "coin")}, by % shared. Not
          confirmed side wallets: matched on timing only.
        </p>
        {/* The wallet modal opens over the page, so this one closes first. */}
        <SideRows list={list} coins={coins} onOpen={onClose} />
      </div>
    </dialog>
  );
}

/** Side wallet rows: address (opens the wallet modal), % shared bar, coins, timing and labels. */
function SideRows({ list, coins, onOpen }: { list: SideWallet[]; coins: number; onOpen?: () => void }) {
  return (
    <ol className="side-sides">
      {list.map((s, i) => (
        <li key={s.wallet}>
          <span className="side-rank num faint">{i + 1}</span>
          <button
            type="button"
            className="link side-wallet num"
            title={`Open ${s.wallet}`}
            onClick={() => {
              onOpen?.();
              openWallet(s.wallet);
            }}
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
  );
}
