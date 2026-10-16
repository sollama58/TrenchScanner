import { useEffect, useMemo, useState } from "react";
import { usePolling } from "../hooks";
import { ago, pct, shortAddress, signedPct } from "../format";
import { openWallet } from "../walletModal";
import { Skeleton } from "./Charts";
import { ChevronDownIcon, WalletIcon } from "./Icons";

/**
 * The Lighthouse tab's "Wallets to watch" (user ask 2026-10-16): how the KOLs on the roster and
 * the wallets our score labels winners trade, from GET /curated/lighthouse/wallets
 * (apps/api/src/walletScorecards.ts). Two kinds of figure, never mixed: how the coins a wallet
 * bought did from our read of them (2x, 4x, 10x, graded like every other Lighthouse rate), and
 * the wallet's own return on the coins it sold out of (SOL out against SOL in).
 */

export interface TierCounts {
  graded: number;
  won2x: number;
  won4x: number;
  won10x: number;
  tenXGraded: number;
}

export interface WalletScorecard {
  wallet: string;
  name: string | null;
  twitter: string | null;
  sides: number;
  coins: number;
  coinTiers: TierCounts;
  closed: number;
  avgReturnPct: number | null;
  medianReturnPct: number | null;
  inProfit: number;
  own2x: number;
  own4x: number;
  own10x: number;
  solIn: number;
  solOut: number;
  early: number;
  snipes: number;
  fastExits: number;
  medianHoldMinutes: number | null;
  best: { mint: string; symbol: string | null; multiple: number } | null;
}

export interface WalletScorecards {
  days: number;
  group: WalletGroup;
  baseline: TierCounts & { coins: number };
  summary: {
    wallets: number;
    coins: number;
    coinTiers: TierCounts;
    closed: number;
    avgReturnPct: number | null;
    inProfit: number;
    own2x: number;
    solIn: number;
    solOut: number;
  };
  wallets: WalletScorecard[];
  closedShare: number;
  computedAt: string;
}

export type WalletGroup = "kols" | "winners";
type Days = 7 | 30;
export type SortKey = "rate2x" | "return" | "net" | "coins";

const GROUPS: { id: WalletGroup; label: string }[] = [
  { id: "kols", label: "KOLs" },
  { id: "winners", label: "Top winners" },
];
const SORTS: { id: SortKey; label: string }[] = [
  { id: "rate2x", label: "2x rate" },
  { id: "return", label: "Return" },
  { id: "net", label: "Net SOL" },
  { id: "coins", label: "Coins" },
];
/** Graded coins a wallet needs before its rates rank it; closed coins before its return does. */
export const MIN_GRADED = 5;
export const MIN_CLOSED = 3;
/** Rows shown before "Show all". */
const FIRST_ROWS = 12;

const VIEW_KEY = "trenchscanner.lighthouse.wallets.v1";
interface View {
  group: WalletGroup;
  days: Days;
  sort: SortKey;
}
function loadView(): View {
  try {
    const v = JSON.parse(localStorage.getItem(VIEW_KEY) ?? "{}") as Partial<View>;
    return {
      group: GROUPS.some((g) => g.id === v.group) ? v.group! : "kols",
      days: v.days === 30 ? 30 : 7,
      sort: SORTS.some((s) => s.id === v.sort) ? v.sort! : "rate2x",
    };
  } catch {
    return { group: "kols", days: 7, sort: "rate2x" };
  }
}

const share = (part: number, whole: number) => (whole > 0 ? (part / whole) * 100 : null);
const rate2x = (t: TierCounts) => share(t.won2x, t.graded);
const sol = (v: number, signed = false) => {
  const text = Math.abs(v) >= 100 ? Math.abs(v).toFixed(0) : Math.abs(v).toFixed(1);
  if (!signed || Number(text) === 0) return `${text} SOL`;
  return `${v > 0 ? "+" : "-"}${text} SOL`;
};
/** Green or red by sign, judged on the figure as shown, so a "0%" is never coloured. */
const tone = (v: number | null, digits = 0) => {
  if (v === null) return "";
  const shown = Number(v.toFixed(digits));
  return shown > 0 ? "lh-up" : shown < 0 ? "lh-down" : "";
};
const holdText = (m: number | null) =>
  m === null ? "–" : m < 1 ? "under a minute" : m < 90 ? `${Math.round(m)} min` : `${(m / 60).toFixed(1)} h`;
const displayName = (w: WalletScorecard) => w.name ?? shortAddress(w.wallet);

/**
 * The reader's order: wallets with enough coins to judge first, by the chosen figure, best first;
 * the rest after them by coins bought, so three lucky coins never top the list.
 */
export function sortWallets(wallets: readonly WalletScorecard[], key: SortKey): WalletScorecard[] {
  const value = (w: WalletScorecard): number | null => {
    switch (key) {
      case "rate2x":
        return w.coinTiers.graded >= MIN_GRADED ? rate2x(w.coinTiers) : null;
      case "return":
        return w.closed >= MIN_CLOSED ? w.avgReturnPct : null;
      case "net":
        return w.solOut - w.solIn;
      case "coins":
        return w.coins;
    }
  };
  return [...wallets].sort((a, b) => {
    const va = value(a);
    const vb = value(b);
    if (va === null || vb === null) {
      if (va !== vb) return va === null ? 1 : -1;
      return b.coins - a.coins;
    }
    return vb - va || b.coins - a.coins;
  });
}

export function LighthouseWallets() {
  const [view, setView] = useState<View>(loadView);
  const [open, setOpen] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  useEffect(() => {
    try {
      localStorage.setItem(VIEW_KEY, JSON.stringify(view));
    } catch {
      // Private mode: the view simply doesn't persist.
    }
  }, [view]);
  const q = usePolling<WalletScorecards>(
    `/curated/lighthouse/wallets?days=${view.days}&group=${view.group}`,
    600_000,
  );
  const d = q.data;
  const sorted = useMemo(() => (d ? sortWallets(d.wallets, view.sort) : []), [d, view.sort]);
  const shown = all ? sorted : sorted.slice(0, FIRST_ROWS);
  const span = view.days === 7 ? "7 days" : "30 days";
  const who = view.group === "kols" ? "KOLs" : "top winners";

  return (
    <section className={`panel lht-wallets${q.stale ? " stale" : ""}`} aria-busy={q.stale}>
      <header className="section-head">
        <div>
          <span className="eyebrow">Wallets to watch · last {span}</span>
          <h2>How the top wallets trade</h2>
          <p className="faint small">
            The {view.group === "kols" ? "KOLs on the roster" : "wallets our score marks as winners"}, in the
            coins we tracked: how those coins did from our read, and what the wallets made on their own
            trades.
          </p>
        </div>
        <div className="feed-controls">
          <div className="segmented small" role="tablist" aria-label="Wallets">
            {GROUPS.map((g) => (
              <button
                key={g.id}
                role="tab"
                aria-selected={g.id === view.group}
                className={g.id === view.group ? "on" : ""}
                onClick={() => setView((v) => ({ ...v, group: g.id }))}
              >
                {g.label}
              </button>
            ))}
          </div>
          <div className="segmented small" role="tablist" aria-label="Window">
            {([7, 30] as const).map((days) => (
              <button
                key={days}
                role="tab"
                aria-selected={days === view.days}
                className={days === view.days ? "on" : ""}
                onClick={() => setView((v) => ({ ...v, days }))}
              >
                {days}d
              </button>
            ))}
          </div>
        </div>
      </header>

      {!d && q.error && <p className="error">Couldn&apos;t load the wallets: {q.error.message}</p>}
      {!d && !q.error && (
        <div className="stack">
          <Skeleton lines={1} height={72} />
          <Skeleton lines={6} />
        </div>
      )}
      {d && d.wallets.length === 0 && (
        <p className="muted small">
          None of the {who} bought a tracked coin in the last {span} yet.
        </p>
      )}
      {d && d.wallets.length > 0 && (
        <div className="stack lw-body">
          <Summary d={d} who={who} />
          <TierCompare d={d} who={who} />

          <div className="lw-sort">
            <span className="lht-control-label">Rank by</span>
            <div className="segmented small" role="tablist" aria-label="Rank by">
              {SORTS.map((s) => (
                <button
                  key={s.id}
                  role="tab"
                  aria-selected={s.id === view.sort}
                  className={s.id === view.sort ? "on" : ""}
                  onClick={() => setView((v) => ({ ...v, sort: s.id }))}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>

          <div className="lw-table" role="table" aria-label={`The ${who}, last ${span}`}>
            <div className="lw-row lw-head faint small" role="row">
              <span role="columnheader">#</span>
              <span role="columnheader">Wallet</span>
              <span role="columnheader" className="num">
                Coins
              </span>
              <span
                role="columnheader"
                className="num"
                title="Coins it bought that cleanly doubled from our read"
              >
                2x
              </span>
              <span role="columnheader" className="num lw-wide">
                4x
              </span>
              <span role="columnheader" className="num lw-wide">
                10x
              </span>
              <span
                role="columnheader"
                className="num"
                title="Its own average return on coins it sold out of"
              >
                Return
              </span>
              <span
                role="columnheader"
                className="num lw-wide"
                title="Coins it sold out of for more SOL than it paid"
              >
                In profit
              </span>
              <span role="columnheader" className="num lw-wide">
                Net SOL
              </span>
              <span aria-hidden />
            </div>
            {shown.map((w, i) => (
              <WalletRow
                key={w.wallet}
                w={w}
                rank={i + 1}
                open={open === w.wallet}
                onToggle={() => setOpen((o) => (o === w.wallet ? null : w.wallet))}
              />
            ))}
          </div>
          <p className="faint small lw-foot">
            {sorted.length > FIRST_ROWS && (
              <>
                <button type="button" className="link" onClick={() => setAll((a) => !a)}>
                  {all ? `Show the top ${FIRST_ROWS}` : `Show all ${sorted.length}`}
                </button>
                {" · "}
              </>
            )}
            2x, 4x and 10x are the share of the coins it bought that got there from the moment we read them,
            graded like every other rate here. Return is its own: SOL out against SOL in, on coins it sold at
            least {Math.round(d.closedShare * 100)}% of. Ranked once a wallet has {MIN_GRADED} graded coins (
            {MIN_CLOSED} sold out of for Return).
            {view.group === "winners" &&
              " Top winners are the 100 off-roster wallets with the highest win score; the coins that earned them the label count here too."}
            {view.group === "kols" && " A KOL's Known Sides count as the KOL."} Updated {ago(d.computedAt)}.
          </p>
        </div>
      )}
    </section>
  );
}

function Summary({ d, who }: { d: WalletScorecards; who: string }) {
  const s = d.summary;
  const groupRate = rate2x(s.coinTiers);
  const baseRate = rate2x(d.baseline);
  const gap = groupRate !== null && baseRate !== null ? groupRate - baseRate : null;
  const net = s.solOut - s.solIn;
  return (
    <section className="lh-kpis" aria-label="Headline numbers">
      <div className="lh-kpi">
        <span className="lh-kpi-label">Active {who}</span>
        <span className="lh-kpi-value num">{s.wallets.toLocaleString("en-US")}</span>
        <span className="muted small">{s.coins.toLocaleString("en-US")} tracked coins bought</span>
      </div>
      <div className="lh-kpi">
        <span className="lh-kpi-label">Their coins that 2x&apos;d</span>
        <span className="lh-kpi-value num">{pct(groupRate)}</span>
        <span className="muted small">
          {gap === null ? (
            "no graded coins yet"
          ) : (
            <>
              <span className={tone(gap)}>
                {gap >= 0 ? "+" : "-"}
                {Math.abs(gap).toFixed(0)} pts
              </span>{" "}
              vs every tracked coin ({pct(baseRate)})
            </>
          )}
        </span>
      </div>
      <div className="lh-kpi">
        <span className="lh-kpi-label">Average return</span>
        <span className={`lh-kpi-value num ${tone(s.avgReturnPct)}`}>{signedPct(s.avgReturnPct)}</span>
        <span className="muted small">
          {s.closed > 0
            ? `${pct(share(s.inProfit, s.closed))} of ${s.closed.toLocaleString("en-US")} closed trades in profit`
            : "no closed trades yet"}
        </span>
      </div>
      <div className="lh-kpi">
        <span className="lh-kpi-label">Net SOL</span>
        <span className={`lh-kpi-value num ${tone(net)}`}>{sol(net, true)}</span>
        <span className="muted small">
          {sol(s.solIn)} in · {sol(s.solOut)} out
        </span>
      </div>
    </section>
  );
}

/** The group's 2x, 4x and 10x rates against every tracked coin's, as paired bars. */
function TierCompare({ d, who }: { d: WalletScorecards; who: string }) {
  const g = d.summary.coinTiers;
  const b = d.baseline;
  const tiers = [
    { label: "2x", group: share(g.won2x, g.graded), base: share(b.won2x, b.graded) },
    { label: "4x", group: share(g.won4x, g.graded), base: share(b.won4x, b.graded) },
    { label: "10x", group: share(g.won10x, g.tenXGraded), base: share(b.won10x, b.tenXGraded) },
  ];
  const top = Math.max(1, ...tiers.flatMap((t) => [t.group ?? 0, t.base ?? 0]));
  // A round scale a little over the tallest bar, so the bars read against one another.
  const scale = top <= 10 ? 10 : top <= 25 ? 25 : top <= 50 ? 50 : 100;
  const width = (v: number | null) => `${Math.max(v ? 1 : 0, ((v ?? 0) / scale) * 100)}%`;
  return (
    <div className="lw-tiers" aria-label={`How often the ${who}' coins reached 2x, 4x and 10x`}>
      <div className="lw-tier-legend faint small">
        <span>
          <i className="lw-swatch group" /> The {who}&apos; coins ({g.graded.toLocaleString("en-US")} graded)
        </span>
        <span>
          <i className="lw-swatch base" /> Every tracked coin ({b.graded.toLocaleString("en-US")})
        </span>
        <span className="lw-scale">scale 0–{scale}%</span>
      </div>
      {tiers.map((t) => (
        <div key={t.label} className="lw-tier">
          <span className="lw-tier-label">{t.label}</span>
          <span className="lw-bars">
            <span className="lw-bar">
              <span className="lw-fill group" style={{ width: width(t.group) }} />
            </span>
            <span className="lw-bar">
              <span className="lw-fill base" style={{ width: width(t.base) }} />
            </span>
          </span>
          <span className="lw-tier-values num">
            <strong>{pct(t.group, t.label === "10x" ? 1 : 0)}</strong>
            <span className="faint">{pct(t.base, t.label === "10x" ? 1 : 0)}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

function WalletRow({
  w,
  rank,
  open,
  onToggle,
}: {
  w: WalletScorecard;
  rank: number;
  open: boolean;
  onToggle: () => void;
}) {
  const t = w.coinTiers;
  const thin = t.graded < MIN_GRADED;
  const r2 = rate2x(t);
  const net = w.solOut - w.solIn;
  const tier = (won: number, over: number, digits = 0) => (over > 0 ? pct(share(won, over), digits) : "–");
  const ret = w.closed >= MIN_CLOSED ? w.avgReturnPct : null;
  const id = `lw-detail-${w.wallet}`;
  return (
    <div className={`lw-item${open ? " open" : ""}${thin ? " thin" : ""}`} role="rowgroup">
      <button
        type="button"
        className="lw-row lw-line"
        role="row"
        aria-expanded={open}
        aria-controls={id}
        onClick={onToggle}
      >
        <span className={`lw-rank num${rank <= 3 && !thin ? ` top top-${rank}` : ""}`} role="cell">
          {rank}
        </span>
        <span className="lw-who" role="cell">
          <span className="lw-name">{displayName(w)}</span>
          <span className="faint small lw-sub">
            {w.twitter ? `@${w.twitter}` : shortAddress(w.wallet)}
            {w.sides > 0 && ` · +${w.sides} side${w.sides === 1 ? "" : "s"}`}
          </span>
        </span>
        <span className="num" role="cell">
          {w.coins}
        </span>
        <span className="num lw-rate" role="cell" title={`${t.won2x} of ${t.graded} graded coins`}>
          <span className={thin ? "faint" : ""}>{tier(t.won2x, t.graded)}</span>
          <span className="lw-mini" aria-hidden>
            <span style={{ width: `${Math.min(100, r2 ?? 0)}%` }} />
          </span>
        </span>
        <span className={`num lw-wide${thin ? " faint" : ""}`} role="cell">
          {tier(t.won4x, t.graded)}
        </span>
        <span className={`num lw-wide${thin ? " faint" : ""}`} role="cell">
          {tier(t.won10x, t.tenXGraded)}
        </span>
        <span className={`num ${ret === null ? "faint" : tone(ret)}`} role="cell">
          {ret === null ? (w.closed ? signedPct(w.avgReturnPct) : "–") : signedPct(ret)}
        </span>
        <span className="num lw-wide" role="cell">
          {w.closed ? pct(share(w.inProfit, w.closed)) : "–"}
        </span>
        <span className={`num lw-wide ${tone(net, 1)}`} role="cell">
          {sol(net, true).replace(" SOL", "")}
        </span>
        <ChevronDownIcon size={15} className="lw-chevron" />
      </button>
      {open && (
        <div className="lw-detail" id={id}>
          <div className="lw-facts">
            <Fact label="Coins" value={`${w.coins}`} sub={`${t.graded} graded so far`} />
            <Fact
              label="Coins to 2x · 4x · 10x"
              value={`${tier(t.won2x, t.graded)} · ${tier(t.won4x, t.graded)} · ${tier(t.won10x, t.tenXGraded, 1)}`}
              sub="from our read of each coin"
            />
            <Fact
              label="Own return"
              value={`${signedPct(w.avgReturnPct)} avg · ${signedPct(w.medianReturnPct)} median`}
              sub={`on ${w.closed} of ${w.coins} coins sold out of`}
              tone={tone(w.avgReturnPct)}
            />
            <Fact
              label="Own 2x · 4x · 10x"
              value={`${w.own2x} · ${w.own4x} · ${w.own10x}`}
              sub={
                w.closed
                  ? `${pct(share(w.own2x, w.closed))} of closed trades at 2x or better`
                  : "no closed trades"
              }
            />
            <Fact
              label="SOL"
              value={sol(net, true)}
              sub={`${sol(w.solIn)} in · ${sol(w.solOut)} out`}
              tone={tone(net)}
            />
            <Fact
              label="First sell after"
              value={holdText(w.medianHoldMinutes)}
              sub="median, from its first buy"
            />
            <Fact
              label="Bought before our read"
              value={pct(share(w.early, w.coins))}
              sub={`${w.snipes} launch snipe${w.snipes === 1 ? "" : "s"} · ${w.fastExits} fast exit${w.fastExits === 1 ? "" : "s"}`}
            />
            <Fact
              label="Best trade"
              value={w.best ? `${w.best.multiple.toFixed(1)}x` : "–"}
              sub={
                w.best
                  ? w.best.symbol
                    ? `$${w.best.symbol}`
                    : shortAddress(w.best.mint)
                  : "nothing sold out of yet"
              }
              tone={w.best && w.best.multiple > 1 ? "lh-up" : ""}
            />
          </div>
          <button type="button" className="ghost small-btn lw-open" onClick={() => openWallet(w.wallet)}>
            <WalletIcon size={14} />
            Open wallet
          </button>
        </div>
      )}
    </div>
  );
}

function Fact({
  label,
  value,
  sub,
  tone = "",
}: {
  label: string;
  value: string;
  sub: string;
  tone?: string;
}) {
  return (
    <div className="lw-fact">
      <span className="faint small">{label}</span>
      <strong className={`num ${tone}`}>{value}</strong>
      <span className="muted small">{sub}</span>
    </div>
  );
}
