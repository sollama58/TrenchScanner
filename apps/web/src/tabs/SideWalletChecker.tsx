import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api";
import { usePolling } from "../hooks";
import { ago, shortAddress } from "../format";
import { openWallet } from "../walletModal";
import { usePossibleSides } from "../possibleSides";
import { SideMatch } from "./SideMatch";
import { Skeleton } from "../components/Charts";
import {
  ChevronDownIcon,
  CheckIcon,
  CloseIcon,
  CopyIcon,
  SearchIcon,
  ShieldIcon,
  TargetIcon,
  UsersIcon,
  WalletIcon,
} from "../components/Icons";

export const SIDE_WINDOWS = ["24h", "7d", "30d"] as const;

/** GET /utilities/side-labels: every labeled side wallet, once, numbered under its KOL. */
export interface SideLabels {
  count: number;
  wallets: { wallet: string; kolWallet: string; kolName: string | null; kind: string; name: string }[];
}

/** The export (user asks 2026-10-14): one WALLET_ADDRESS,KOL_N per line, copied to the clipboard. */
export function sideLabelsText(labels: SideLabels): string {
  return labels.wallets.map((w) => `${w.wallet},${w.name}\n`).join("");
}

/** The download the copy falls back to when the browser blocks the clipboard. */
function downloadSideLabels(labels: SideLabels) {
  const url = URL.createObjectURL(new Blob([sideLabelsText(labels)], { type: "text/plain" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `kol-side-wallets-${new Date().toISOString().slice(0, 10)}.txt`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
export type SideWindow = (typeof SIDE_WINDOWS)[number];

/** Mirrors SideWalletRules in core's wallets/sideWalletRules.ts: every cutoff the lists and labels use. */
export interface SideRules {
  gapMinutes: number;
  minShared: Record<SideWindow, number>;
  minPct: number;
  bot: { minCoins: number; minPct: number; days: number };
  likelyBot?: { minKols: number; minPct: number; minShared: number; window: SideWindow };
  tiers: { hours: number; minPct: number; minShared: number }[];
  holdDays: number;
}

/** The cutoffs as of 2026-10-14, for an API build that doesn't send them yet. */
const DEFAULT_RULES: SideRules = {
  gapMinutes: 5,
  minShared: { "24h": 5, "7d": 15, "30d": 25 },
  minPct: 50,
  bot: { minCoins: 200, minPct: 75, days: 30 },
  likelyBot: { minKols: 4, minPct: 60, minShared: 50, window: "7d" },
  tiers: [
    { hours: 24, minPct: 100, minShared: 10 },
    { hours: 48, minPct: 90, minShared: 25 },
    { hours: 72, minPct: 80, minShared: 50 },
  ],
  holdDays: 90,
};

/** Mirrors apps/api/src/routes/utilities.ts GET /utilities/side-wallets. */
interface SideLeaderboard {
  computedAt: string | null;
  gapMinutes: number;
  rules?: SideRules;
  kols: {
    wallet: string;
    name: string | null;
    twitter: string | null;
    /** Another wallet of a KOL whose main wallet is set: that main wallet. Absent from older API builds. */
    knownSideOf?: { wallet: string; name: string | null } | null;
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
  rules?: SideRules;
  /** Wallets taken off its lists as likely bots (absent from older API builds). */
  likelyBots?: string[];
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

/** "24h", "2 days", "3 days": a tier's span in words. */
const spanText = (hours: number) => (hours % 24 === 0 && hours > 24 ? `${hours / 24} days` : `${hours}h`);

/** The first letter or digit of a KOL's name, for its avatar. */
const initial = (name: string) => (name.match(/[\p{L}\p{N}]/u)?.[0] ?? "?").toUpperCase();

/**
 * The Side Wallet Checker, free on the Utilities tab: the KOLs we track, ranked by how many of
 * our coins they bought in the last 30 days. Opening one lists the top wallets that bought the
 * most of the same coins within a few minutes of it, sorted by % shared in the period picked.
 * The cutoffs those lists and the "Possible Side" labels use are shown above the list.
 */
export function SideWalletChecker() {
  const { data, error } = usePolling<SideLeaderboard>("/utilities/side-wallets", 600_000);
  const { data: labels } = usePolling<SideLabels>("/utilities/side-labels", 600_000);
  const [open, setOpen] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const [period, setPeriod] = useState<SideWindow>("30d");
  const [query, setQuery] = useState("");
  const kols = data?.kols ?? [];
  const rules = data?.rules ?? DEFAULT_RULES;
  const q = query.trim().toLowerCase().replace(/^@/, "");
  // A search shows every match, each at its own leaderboard rank.
  const matches = kols
    .map((k, i) => ({ k, rank: i + 1 }))
    .filter(({ k }) => !q || [k.name, k.twitter, k.wallet].some((v) => v?.toLowerCase().includes(q)));
  const shown = all || q ? matches : matches.slice(0, FIRST_ROWS);
  const withSides = kols.filter((k) => k.sides["30d"] > 0).length;
  // The KOLs with a Known Side on the list: their own row says it is the main wallet.
  const mains = new Set(kols.flatMap((k) => (k.knownSideOf ? [k.knownSideOf.wallet] : [])));
  const listed = kols.reduce((n, k) => n + k.sides["30d"], 0);

  return (
    <section className="panel util-side">
      <header className="section-head">
        <div>
          <span className="eyebrow brand-eyebrow">
            <UsersIcon size={13} /> Side Wallet Checker
          </span>
          <h2>Who trades alongside the KOLs</h2>
        </div>
        <span className="util-cost util-free">Free</span>
      </header>
      <p className="muted small side-lead">
        KOLs ranked by how many of our tracked coins they bought in the last 30 days. Open one to see the
        wallets that bought the same coins within {rules.gapMinutes} minutes of it, by the share of the
        KOL&apos;s coins they were in.
      </p>
      {data && kols.length > 0 && (
        <div className="side-stats">
          <div className="side-stat">
            <span className="side-stat-value num">
              {kols.filter((k) => !k.knownSideOf).length.toLocaleString("en-US")}
            </span>
            <span className="faint small">KOLs active in 30 days</span>
          </div>
          <div className="side-stat">
            <span className="side-stat-value num">{withSides.toLocaleString("en-US")}</span>
            <span className="faint small">with wallets listed</span>
          </div>
          <div className="side-stat">
            <span className="side-stat-value num">{listed.toLocaleString("en-US")}</span>
            <span className="faint small">wallets listed in 30 days</span>
          </div>
        </div>
      )}
      <SideRulesCard rules={rules} labels={labels} />
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
              // A KOL's Known Side reads as one, not as a second entry of the same KOL.
              const side = k.knownSideOf ?? null;
              const name = side
                ? `${side.name ?? k.name ?? shortAddress(side.wallet)} Known Side`
                : (k.name ?? shortAddress(k.wallet));
              const isMain = !side && mains.has(k.wallet);
              return (
                <li key={k.wallet} className={isOpen ? "open" : undefined}>
                  <div className="side-line">
                    <button
                      type="button"
                      className="side-row"
                      aria-expanded={isOpen}
                      onClick={() => setOpen(isOpen ? null : k.wallet)}
                    >
                      <span className={`side-rank num${rank <= 3 ? ` top top-${rank}` : ""}`}>{rank}</span>
                      <span className="side-who">
                        <span className="side-avatar" aria-hidden="true">
                          {initial(name)}
                        </span>
                        <span className="side-who-text">
                          <strong>{name}</strong>
                          <span className="faint small num">
                            {side
                              ? `Main wallet ${shortAddress(side.wallet)} · `
                              : isMain
                                ? "Main wallet · "
                                : ""}
                            {k.twitter ? `@${k.twitter} · ` : ""}
                            {shortAddress(k.wallet)}
                          </span>
                        </span>
                        {k.sides["30d"] > 0 && (
                          <span className="pill side-found" title="Wallets listed for it over 30 days">
                            {plural(k.sides["30d"], "possible wallet")}
                          </span>
                        )}
                      </span>
                      {SIDE_WINDOWS.map((w) => (
                        <span key={w} className={`num side-count${w === "30d" ? " main" : ""}`}>
                          {k.coins[w].toLocaleString("en-US")}
                        </span>
                      ))}
                      <ChevronDownIcon size={16} className="side-chevron" />
                    </button>
                    {/* Its wallet profile (user ask 2026-10-14), beside the row: a button can't hold another. */}
                    <button
                      type="button"
                      className="ghost icon-btn side-profile"
                      title={`Open ${name}'s wallet profile`}
                      aria-label={`Open ${name}'s wallet profile`}
                      onClick={() => openWallet(k.wallet)}
                    >
                      <WalletIcon size={15} />
                    </button>
                  </div>
                  {isOpen && (
                    <SideWallets kol={k.wallet} kolName={name} period={period} setPeriod={setPeriod} />
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

/** The cutoffs a wallet must meet to be listed, to carry the label, and to be left out. */
function SideRulesCard({ rules, labels }: { rules: SideRules; labels: SideLabels | null | undefined }) {
  const [copied, setCopied] = useState<"copied" | "downloaded" | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async (l: SideLabels) => {
    let done: "copied" | "downloaded" = "copied";
    try {
      await navigator.clipboard.writeText(sideLabelsText(l));
    } catch {
      downloadSideLabels(l);
      done = "downloaded";
    }
    setCopied(done);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(null), 2500);
  };
  return (
    <div className="side-rules" aria-label="Match rules">
      <div className="side-rule">
        <h3>
          <UsersIcon size={14} /> Listed
        </h3>
        <div className="side-chips">
          {SIDE_WINDOWS.map((w) => (
            <span key={w} className="side-chip">
              <span className="faint">{w}</span>
              <strong className="num">{rules.minShared[w]}+ coins</strong>
            </span>
          ))}
        </div>
        <p className="faint small">
          Bought within {rules.gapMinutes} minutes of the KOL, on at least {rules.minPct}% of its coins in the
          window. A wallet listed for 24h is listed for 7d and 30d too, and one listed for 7d for 30d.
        </p>
      </div>
      <div className="side-rule side-rule-label">
        <h3>
          <TargetIcon size={14} /> Possible Side label
        </h3>
        <ul className="side-tiers">
          {rules.tiers.map((t) => (
            <li key={t.hours}>
              <strong className="num">{t.minPct === 100 ? "All" : `${t.minPct}%+`}</strong>
              <span className="num">{t.minShared}+ coins</span>
              <span className="faint num">{spanText(t.hours)}</span>
            </li>
          ))}
        </ul>
        <p className="faint small">
          Any one tier. Shown on the wallet and the bubble map for {rules.holdDays} days after it last
          qualifies. A wallet the KOL funded is labeled KOL Funded Wallet whatever its trades.
        </p>
      </div>
      <div className="side-rule">
        <h3>
          <ShieldIcon size={14} /> Left out
        </h3>
        <p className="small">
          <strong>Bots:</strong> {rules.bot.minCoins}+ coins and over {rules.bot.minPct}% of every tracked
          coin in {rules.bot.days} days.
        </p>
        {rules.likelyBot && (
          <p className="small">
            <strong>Likely bots:</strong> over {rules.likelyBot.minShared} coins at over{" "}
            {rules.likelyBot.minPct}% with each of {rules.likelyBot.minKols}+ KOLs in {rules.likelyBot.window}
            .
          </p>
        )}
        <p className="faint small">Other KOLs and known exchange wallets.</p>
      </div>
      <div className="side-rule side-rule-export">
        <h3>
          <WalletIcon size={14} /> Labeled sides
        </h3>
        <strong className="side-stat-value num">{labels ? labels.count.toLocaleString("en-US") : "—"}</strong>
        <p className="faint small">
          High-confidence (Possible Side), Known and KOL Funded wallets, each once under its KOL. Export
          copies them as one address,KOL_N per line.
        </p>
        <button
          type="button"
          className="ghost small-btn side-export"
          disabled={!labels || labels.count === 0}
          onClick={() => labels && void copy(labels)}
        >
          {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}{" "}
          {copied === "copied"
            ? `Copied ${plural(labels?.count ?? 0, "wallet")}`
            : copied === "downloaded"
              ? "Clipboard blocked: downloaded"
              : "Export"}
        </button>
      </div>
    </div>
  );
}

/**
 * One KOL's top ten side wallets in the period picked, and the rest in a modal: the leaderboard's
 * dropdown, and the KOL's own wallet modal (KolSideWallets below).
 */
function SideWallets({
  kol,
  kolName,
  period,
  setPeriod,
}: {
  kol: string;
  kolName: string;
  period: SideWindow;
  setPeriod: (w: SideWindow) => void;
}) {
  const [data, setData] = useState<KolSides | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [showAll, setShowAll] = useState(false);
  useEffect(() => {
    let live = true;
    api<KolSides>(`/utilities/side-wallets/${encodeURIComponent(kol)}`)
      .then((d) => live && setData(d))
      .catch((e: unknown) => {
        if (!live) return;
        // Not on the leaderboard: no tracked coin in the last 30 days, or the list hasn't rebuilt yet.
        if (e instanceof ApiError && e.status === 404) setMissing(true);
        else setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      live = false;
    };
  }, [kol]);

  const rules = data?.rules ?? DEFAULT_RULES;
  const list = data?.sides[period] ?? [];
  const coins = data?.coins[period] ?? 0;
  return (
    <div className="side-drop">
      <div className="side-drop-head">
        <span className="small">
          Top wallets sharing {kolName}&apos;s trades, by % shared
          <span className="faint">
            {" "}
            · {rules.minShared[period]}+ coins and {rules.minPct}%+ to list
          </span>
        </span>
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
      {missing ? (
        <p className="muted small">
          No side wallets listed yet: the list covers KOLs that bought a tracked coin in the last 30 days.
        </p>
      ) : error ? (
        <p className="error small">Couldn&apos;t load its side wallets: {error}</p>
      ) : !data ? (
        <Skeleton lines={3} />
      ) : list.length === 0 ? (
        <p className="muted small side-empty">
          {coins === 0
            ? `No tracked coins in the last ${period}.`
            : `No wallet shared ${rules.minShared[period]} or more of its ${plural(coins, "coin")} (and ${rules.minPct}% or more) in the last ${period}.`}
        </p>
      ) : (
        <>
          <SideRows
            kol={kol}
            kolName={kolName}
            period={period}
            list={list.slice(0, DROP_ROWS)}
            coins={coins}
          />
          {list.length > DROP_ROWS && (
            <button type="button" className="ghost small-btn side-all" onClick={() => setShowAll(true)}>
              Show all {list.length} wallets
            </button>
          )}
        </>
      )}
      {data && (data.likelyBots?.length ?? 0) > 0 && (
        <p className="faint small side-hidden-bots">
          {plural(data.likelyBots!.length, "likely bot")} hidden: strongly matched with{" "}
          {rules.likelyBot?.minKols ?? 4}+ KOLs, which fits a copy-trade bot more than a side wallet.
        </p>
      )}
      {showAll && (
        <SideWalletsModal
          kol={kol}
          kolName={kolName}
          period={period}
          list={list}
          coins={coins}
          rules={rules}
          onClose={() => setShowAll(false)}
        />
      )}
    </div>
  );
}

/** Every listed side wallet for one KOL and window, in a native modal (a sheet on phones). */
function SideWalletsModal({
  kol,
  kolName,
  period,
  list,
  coins,
  rules,
  onClose,
}: {
  kol: string;
  kolName: string;
  period: SideWindow;
  list: SideWallet[];
  coins: number;
  rules: SideRules;
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
          All {list.length} wallets that shared at least {rules.minShared[period]} of its{" "}
          {plural(coins, "coin")} and {rules.minPct}% or more, by % shared. Not confirmed side wallets:
          matched on timing only.
        </p>
        {/* The wallet modal opens over the page, so this one closes first. */}
        <SideRows kol={kol} kolName={kolName} period={period} list={list} coins={coins} onOpen={onClose} />
      </div>
    </dialog>
  );
}

/**
 * Side wallet rows: address (opens the wallet modal), % shared bar, coins, timing and labels. A row
 * opens the coins it bought with the KOL, leg by leg (SideMatch).
 */
function SideRows({
  kol,
  kolName,
  period,
  list,
  coins,
  onOpen,
}: {
  kol: string;
  kolName: string;
  period: SideWindow;
  list: SideWallet[];
  coins: number;
  onOpen?: () => void;
}) {
  const labels = usePossibleSides(list.map((s) => s.wallet));
  const [open, setOpen] = useState<string | null>(null);
  return (
    <ol className="side-sides">
      {list.map((s, i) => {
        const label = labels[s.wallet]?.find((p) => p.kolWallet === kol);
        const isOpen = open === s.wallet;
        const toggle = () => setOpen(isOpen ? null : s.wallet);
        return (
          <li
            key={s.wallet}
            className={[label ? "labeled" : "", isOpen ? "open" : ""].join(" ").trim() || undefined}
            // The row opens and closes its trades; the address, the toggle and the open panel itself don't.
            onClick={(e) => {
              if (!(e.target as HTMLElement).closest("button, a, .sm-body")) toggle();
            }}
          >
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
            <span className={`side-pct num${s.pct >= 90 ? " strong" : ""}`}>
              {s.pct.toFixed(s.pct >= 10 ? 0 : 1)}%
            </span>
            <span className="side-meta faint small num">
              <span title="Coins it bought with the KOL, of the KOL's coins in the window">
                {s.shared}/{coins} coins
              </span>
              <span title="Median time from the KOL's buy to its own">· {gapText(s.gapSec)}</span>
              <span title="Every tracked coin it bought in the window">· {s.coins} total</span>
            </span>
            <span className="side-tags">
              {label?.funded ? (
                <span
                  className="pill side-label side-funded"
                  title="The KOL paid for this wallet's first SOL"
                >
                  <TargetIcon size={11} /> KOL Funded Wallet
                </span>
              ) : (
                label && (
                  <span
                    className="pill side-label"
                    title={`Met a Possible Side tier: ${Math.round(label.pct)}% of the KOL's coins over ${label.hours ?? 24} hours`}
                  >
                    <TargetIcon size={11} /> Possible Side
                  </span>
                )
              )}
              {s.risk?.winner && (
                <span
                  className="pill"
                  title="Winner: 60%+ of the called coins it bought doubled. Presence only, not a buy signal."
                >
                  Winner
                </span>
              )}
              {s.risk?.dumper && <span className="pill pill-warn">Dumper</span>}
              {s.risk?.sniper && <span className="pill">Sniper</span>}
            </span>
            <button
              type="button"
              className="ghost small-btn side-trades-btn"
              aria-expanded={isOpen}
              onClick={toggle}
            >
              {isOpen ? "Hide trades" : `Compare ${s.shared} trades`}
              <ChevronDownIcon size={13} className="side-chevron" />
            </button>
            {isOpen && (
              <SideMatch kol={kol} kolName={kolName} side={s.wallet} period={period} onOpen={onOpen} />
            )}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * A KOL's likely side wallets in its own wallet modal (user ask 2026-10-14): the leaderboard's
 * dropdown for that one wallet, with the same disclaimer.
 */
export function KolSideWallets({ wallet, kolName }: { wallet: string; kolName: string }) {
  const [period, setPeriod] = useState<SideWindow>("30d");
  return (
    <section className="sage-card wm-section wm-sides">
      <h4>Likely side wallets</h4>
      <p className="faint small wm-note">
        Wallets that bought the same coins within minutes of it. Not confirmed to belong to it: a wallet here
        may be a copy trader, a friend, a bot or chance.
      </p>
      <SideWallets kol={wallet} kolName={kolName} period={period} setPeriod={setPeriod} />
    </section>
  );
}
