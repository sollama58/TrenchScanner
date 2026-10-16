import { useMemo, useState, type FormEvent } from "react";
import { usePolling } from "../hooks";
import { MIN_WIN_SOL, pct } from "../format";
import { useWalletNames } from "../walletNames";
import { Kpi, Load, Panel, Table, Tag, Wallet, n, when } from "./adminShared";

/**
 * The Admin "Wallets" section (apps/api/src/routes/adminWallets.ts): every wallet's risk score,
 * built hourly from the trade tape of called coins - how often it sold into a stop, against the
 * market, nudged up by fast exits and launch snipes. The riskiest wallets, what led the stops over
 * the last day, and a search by wallet or by coin.
 */

type StopRole = "creator" | "launchSnipers" | "firstBuyers" | "top10" | "other";
const ROLE_LABEL: Record<StopRole, string> = {
  creator: "Creator",
  launchSnipers: "Launch snipers",
  firstBuyers: "First 25 buyers",
  top10: "Top-10 holders",
  other: "Everyone else",
};

interface Overview {
  computedAt: string | null;
  scoredWallets: number;
  riskyWallets: number;
  riskyScore: number;
  /** The win side. Absent from older API builds. */
  winnerWallets?: number;
  winnerRule?: { minWins: number; lowerBoundVsMarket: number; minCoins?: number };
  dumperRule?: { minDumps: number; minRate: number; minCoins?: number };
  tapes: Record<string, number>;
  tapes24h: { status: string; source: string | null; count: number }[];
  stopCauses: {
    stops: number;
    led: Record<StopRole, number>;
    meanShare: Record<StopRole, number>;
    medianSellers: number | null;
  };
  wallets: {
    wallet: string;
    score: number;
    appearances: number;
    dumps: number;
    fastExits: number;
    snipes: number;
    wins?: number;
    earlyWins?: number;
    winScore?: number;
    dumper?: boolean;
    winner?: boolean;
    sniper?: boolean;
    medianSupplyPct: number | null;
    solIn: number;
    solOut: number;
    lastSeenAt: string;
  }[];
  winners?: Overview["wallets"];
}

interface WalletDetail {
  wallet: string;
  risk: { score: number; appearances: number; dumps: number; fastExits: number; snipes: number } | null;
  coins: {
    mint: string;
    symbol: string | null;
    anchorAt: string | null;
    reason: string | null;
    outcome: "win" | "stop" | "fizzle" | null;
    solIn: number;
    solOut: number;
    boughtPct: number | null;
    dumpSol: number;
    roles: string[];
  }[];
}

interface CoinDetail {
  mint: string;
  symbol: string | null;
  tape: { status: string; source: string | null; trades: number; readAt: string; anchorAt: string } | null;
  stopCause: { lead: StopRole | null; sellers: number; soldSol: number } | null;
  wallets: {
    wallet: string;
    score: number | null;
    coins: number | null;
    heldPctAtAnchor: number | null;
    solIn: number;
    solOut: number;
    roles: string[];
  }[];
}

const sol = (v: number) => `${v.toFixed(v >= 10 ? 0 : 2)} SOL`;
const scoreTag = (score: number | null, risky: number) =>
  score === null ? (
    <span className="faint">–</span>
  ) : (
    <Tag tone={score >= risky ? "bad" : score >= 50 ? "warn" : "muted"}>{score.toFixed(0)}</Tag>
  );
const winTag = (score: number, winner: boolean) => (
  <Tag tone={winner ? "ok" : score >= 50 ? "warn" : "muted"}>{score.toFixed(0)}</Tag>
);
const labelsOf = (w: { dumper?: boolean; winner?: boolean; sniper?: boolean }) =>
  [w.dumper && "dumper", w.winner && "winner", w.sniper && "sniper"].filter(Boolean).join(", ") || "–";

export function WalletsAdmin() {
  const q = usePolling<Overview>("/admin/wallets?limit=50", 120_000);
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  // One read names both tables (the riskiest and the winning wallets).
  const names = useWalletNames(
    useMemo(() => [...(q.data?.wallets ?? []), ...(q.data?.winners ?? [])].map((w) => w.wallet), [q.data]),
  );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const v = search.trim();
    if (v) setOpen(v);
  };
  return (
    <div className="stack">
      <Load q={q}>
        {(r) => (
          <div className="stack">
            <div className="kpis">
              <Kpi
                label="Scored wallets"
                value={n(r.scoredWallets)}
                sub={<>rebuilt {when(r.computedAt)} · seen in 2+ coins</>}
              />
              <Kpi
                label={`Risky (${r.riskyScore}+)`}
                value={n(r.riskyWallets)}
                tone={r.riskyWallets ? "warn" : undefined}
              />
              <Kpi
                label="Winners"
                value={n(r.winnerWallets ?? 0)}
                sub={
                  r.winnerRule
                    ? `${r.winnerRule.minWins}+ own 2x trades, a win rate at least ${r.winnerRule.lowerBoundVsMarket}x the market's, ${r.winnerRule.minCoins ?? 10}+ coins`
                    : undefined
                }
                tone={r.winnerWallets ? "ok" : undefined}
              />
              <Kpi
                label="Coins read"
                value={n((r.tapes.done ?? 0) + (r.tapes.partial ?? 0))}
                sub={`${n(r.tapes.partial ?? 0)} partial · ${n(r.tapes.failed ?? 0)} failing`}
              />
              <Kpi
                label="Stops explained, 24h"
                value={n(r.stopCauses.stops)}
                sub={`median ${n(r.stopCauses.medianSellers)} sellers`}
              />
            </div>
            <Panel
              title="What led the stops, last 24 hours"
              note="Who sold between the call and the stop, by SOL. Each seller counts under one role, the first that fits in this order."
            >
              <Table
                head={["Role", "Led the stop", "Mean share of the selling"]}
                rows={(Object.keys(ROLE_LABEL) as StopRole[]).map((role) => [
                  ROLE_LABEL[role],
                  r.stopCauses.stops
                    ? `${n(r.stopCauses.led[role])} (${pct((r.stopCauses.led[role] / r.stopCauses.stops) * 100)})`
                    : "–",
                  pct(r.stopCauses.meanShare[role] * 100),
                ])}
                empty="No stopped calls read yet."
              />
            </Panel>
            <Panel
              title="Riskiest wallets"
              note={`Seen in 3+ coins. Known dumper needs ${r.dumperRule?.minDumps ?? 4}+ coins sold into the stop and ${Math.round((r.dumperRule?.minRate ?? 0.75) * 100)}% of its coins; no label under ${r.dumperRule?.minCoins ?? 10} coins on record. Tap a wallet for its coins.`}
            >
              <Table
                head={[
                  "Wallet",
                  "Score",
                  "Labels",
                  "Coins",
                  "Dumps",
                  "Fast exits",
                  "Snipes",
                  "SOL in / out",
                  "Last seen",
                ]}
                rows={r.wallets.map((w) => [
                  <span key="w">
                    <Wallet address={w.wallet} names={names} />{" "}
                    <button className="link small" onClick={() => setOpen(w.wallet)}>
                      coins
                    </button>
                  </span>,
                  scoreTag(w.score, r.riskyScore),
                  labelsOf(w),
                  n(w.appearances),
                  n(w.dumps),
                  n(w.fastExits),
                  n(w.snipes),
                  `${sol(w.solIn)} / ${sol(w.solOut)}`,
                  when(w.lastSeenAt),
                ])}
                empty="No wallet scored yet: the trade tape fills over the first hours."
              />
            </Panel>
            <Panel
              title="Winning wallets"
              note={`Labelled winners seen in 3+ coins, by win score: how often the coins it bought doubled with ${MIN_WIN_SOL}+ SOL profit, against the market, nudged up by buying before the call. Tap a wallet for its coins.`}
            >
              <Table
                head={[
                  "Wallet",
                  "Win score",
                  "Coins",
                  "Doubled",
                  "Bought before the call",
                  "Risk",
                  "SOL in / out",
                  "Last seen",
                ]}
                rows={(r.winners ?? []).map((w) => [
                  <span key="w">
                    <Wallet address={w.wallet} names={names} />{" "}
                    <button className="link small" onClick={() => setOpen(w.wallet)}>
                      coins
                    </button>
                  </span>,
                  winTag(w.winScore ?? 0, w.winner === true),
                  n(w.appearances),
                  n(w.wins ?? 0),
                  n(w.earlyWins ?? 0),
                  scoreTag(w.score, r.riskyScore),
                  `${sol(w.solIn)} / ${sol(w.solOut)}`,
                  when(w.lastSeenAt),
                ])}
                empty="No winner yet: a wallet needs a doubled coin on a read tape."
              />
            </Panel>
          </div>
        )}
      </Load>
      <Panel
        title="Look up"
        note="A wallet address for its coins, or a coin's mint for its holders and first buyers."
      >
        <form className="row" onSubmit={submit}>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Wallet or mint address"
            aria-label="Wallet or mint address"
            spellCheck={false}
          />
          <button type="submit">Look up</button>
        </form>
      </Panel>
      {open && <Lookup key={open} address={open} risky={q.data?.riskyScore ?? 70} />}
    </div>
  );
}

function Lookup({ address, risky }: { address: string; risky: number }) {
  const wallet = usePolling<WalletDetail>(`/admin/wallets/${address}`, 600_000);
  const coin = usePolling<CoinDetail>(`/admin/wallets/coin/${address}`, 600_000);
  if (coin.data) return <CoinView c={coin.data} risky={risky} />;
  return (
    <Load q={wallet}>
      {(w) => (
        <Panel
          title={`Wallet ${address.slice(0, 6)}…`}
          note={
            w.risk ? (
              <>
                Score {w.risk.score.toFixed(0)} over {n(w.risk.appearances)} coins: {n(w.risk.dumps)} dumps,{" "}
                {n(w.risk.fastExits)} fast exits, {n(w.risk.snipes)} snipes.
              </>
            ) : (
              "Not scored: seen in fewer than two coins read."
            )
          }
          actions={<Wallet address={address} />}
        >
          <Table
            head={["Coin", "Called", "Outcome", "What it did", "SOL in / out", "Bought", "Sold into stop"]}
            rows={w.coins.map((c) => [
              c.symbol ?? c.mint.slice(0, 6),
              when(c.anchorAt),
              c.outcome ? (
                <Tag tone={c.outcome === "win" ? "ok" : c.outcome === "stop" ? "bad" : "muted"}>
                  {c.outcome}
                </Tag>
              ) : (
                "–"
              ),
              c.roles.join(", ") || "–",
              `${sol(c.solIn)} / ${sol(c.solOut)}`,
              c.boughtPct === null ? "–" : pct(c.boughtPct, 2),
              c.dumpSol ? sol(c.dumpSol) : "–",
            ])}
            empty="No coin read with this wallet in it."
          />
        </Panel>
      )}
    </Load>
  );
}

function CoinView({ c, risky }: { c: CoinDetail; risky: number }) {
  const names = useWalletNames(useMemo(() => c.wallets.map((w) => w.wallet), [c]));
  return (
    <Panel
      title={`${c.symbol ?? "Coin"}: holders and first buyers`}
      note={
        c.tape ? (
          <>
            {n(c.tape.trades)} trades read from {c.tape.source} ({c.tape.status}) {when(c.tape.readAt)}.
            {c.stopCause && c.stopCause.lead && (
              <>
                {" "}
                Stopped: {ROLE_LABEL[c.stopCause.lead].toLowerCase()} led the selling,{" "}
                {n(c.stopCause.sellers)} sellers, {sol(c.stopCause.soldSol)}.
              </>
            )}
          </>
        ) : (
          "Trades not read yet."
        )
      }
    >
      <Table
        head={["Wallet", "Score", "Coins", "Held at call", "Roles", "SOL in / out"]}
        rows={c.wallets.map((w) => [
          <Wallet key="w" address={w.wallet} names={names} />,
          scoreTag(w.score, risky),
          n(w.coins),
          w.heldPctAtAnchor === null ? "–" : pct(w.heldPctAtAnchor, 1),
          w.roles.join(", ") || "–",
          `${sol(w.solIn)} / ${sol(w.solOut)}`,
        ])}
        empty="No holders or first buyers recorded."
      />
    </Panel>
  );
}
