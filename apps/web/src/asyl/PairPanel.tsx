import { useEffect, useMemo, useState } from "react";
import { ago, tokenImageSources } from "../format";
import { asylApi, type PairCoin, type PairRead, type PairSide, type PairTrade } from "./asylApi";
import { gapText } from "./Inspector";

/**
 * The trades behind a "bought together" link (user ask 2026-10-25): each coin both wallets bought
 * within minutes of each other, side by side, with who went first and by how much, what each put
 * in and took out, when each got out, and a timeline of their trades on the coin. Over the map, as
 * a panel of its own; Esc or the close button leaves it.
 */

const solText = (n: number) => {
  const a = Math.abs(n);
  return `${a >= 100 ? a.toFixed(0) : a >= 10 ? a.toFixed(1) : a >= 1 ? a.toFixed(2) : a.toFixed(3)}`;
};
const signed = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${solText(n)}`;
const clock = (iso: string) => {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

function CoinImage({ coin }: { coin: PairCoin }) {
  const sources = tokenImageSources(coin.image, 64, coin.mint);
  const [n, setN] = useState(0);
  const src = sources[n];
  const label = (coin.symbol ?? coin.name ?? "?").slice(0, 2).toUpperCase();
  return src ? (
    <img className="asyl-pair-coin-img" src={src} alt="" loading="lazy" onError={() => setN((i) => i + 1)} />
  ) : (
    <span className="asyl-pair-coin-img asyl-pair-coin-none">{label}</span>
  );
}

/** Both wallets' trades on one coin along one line of time: A above, B below, sized by SOL. */
function Timeline({ coin }: { coin: PairCoin }) {
  const W = 560;
  const H = 74;
  const pad = 16;
  const pts = (side: PairSide, fallback: string): PairTrade[] =>
    side.trades.length ? side.trades : [[Date.parse(fallback), 1, side.solIn, 0]];
  const ta = pts(coin.a, coin.a.firstBuyAt);
  const tb = pts(coin.b, coin.b.firstBuyAt);
  const all = [...ta, ...tb];
  const t0 = Math.min(...all.map((t) => t[0]));
  const t1 = Math.max(...all.map((t) => t[0]), t0 + 1000);
  const maxSol = Math.max(...all.map((t) => t[2]), 0.0001);
  const x = (ms: number) => pad + ((ms - t0) / (t1 - t0)) * (W - pad * 2);
  const r = (sol: number) => 3 + Math.sqrt(sol / maxSol) * 8;
  const span = (t1 - t0) / 1000;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => ({ f, s: Math.round(span * f) }));
  const marks = (trades: PairTrade[], y: number, who: "a" | "b") =>
    trades.map((t, i) => (
      <g key={`${who}${i}`}>
        <line x1={x(t[0])} x2={x(t[0])} y1={H / 2} y2={y} className={`asyl-tl-stem ${who}`} />
        <circle
          cx={x(t[0])}
          cy={y}
          r={r(t[2])}
          className={`asyl-tl-dot ${who} ${t[1] === 1 ? "buy" : "sell"}`}
        >
          <title>
            {`${who === "a" ? "A" : "B"} ${t[1] === 1 ? "bought" : "sold"} ${solText(t[2])} SOL at ${clock(new Date(t[0]).toISOString())}`}
          </title>
        </circle>
      </g>
    ));
  return (
    <svg className="asyl-tl" viewBox={`0 0 ${W} ${H + 14}`} role="img" aria-label="Their trades on this coin">
      <line x1={pad} x2={W - pad} y1={H / 2} y2={H / 2} className="asyl-tl-axis" />
      {ticks.map(({ f, s }) => (
        <text
          key={f}
          x={pad + f * (W - pad * 2)}
          y={H + 11}
          className="asyl-tl-tick"
          textAnchor={f === 0 ? "start" : f === 1 ? "end" : "middle"}
        >
          {f === 0 ? "0s" : `+${gapText(s)}`}
        </text>
      ))}
      {marks(ta, 16, "a")}
      {marks(tb, H - 16, "b")}
    </svg>
  );
}

function SideCell({ s, who }: { s: PairSide; who: "a" | "b" }) {
  const held = s.sells === 0;
  return (
    <div className={`asyl-pair-side ${who}`}>
      <div className="asyl-pair-side-top">
        <span className={`asyl-pair-dot ${who}`} />
        <b>{solText(s.solIn)} SOL</b>
        <span className="asyl-muted">
          in · {s.buys} buy{s.buys === 1 ? "" : "s"}
        </span>
      </div>
      <div className="asyl-pair-side-row">
        {held ? (
          <span className="asyl-pair-pill hold">Still holding</span>
        ) : (
          <span className={`asyl-pair-pnl ${s.netSol >= 0 ? "up" : "down"}`}>{signed(s.netSol)} SOL</span>
        )}
        {s.firstSellAt && (
          <span className="asyl-muted">
            out after {gapText((Date.parse(s.firstSellAt) - Date.parse(s.firstBuyAt)) / 1000)}
          </span>
        )}
      </div>
      <div className="asyl-pair-flags">
        {s.sniper && <span className="asyl-pair-pill warn">Sniped</span>}
        {s.firstBuyerRank && <span className="asyl-pair-pill">Buyer #{s.firstBuyerRank}</span>}
        {s.fastExit && <span className="asyl-pair-pill warn">Fast exit</span>}
        {s.boughtPct !== null && s.boughtPct > 0 && (
          <span className="asyl-pair-pill">{s.boughtPct.toFixed(s.boughtPct < 1 ? 2 : 1)}% of supply</span>
        )}
      </div>
    </div>
  );
}

type Sort = "recent" | "gap" | "size";

export function PairPanel({
  a,
  b,
  nameOf,
  onSelect,
  onClose,
}: {
  a: string;
  b: string;
  nameOf: (id: string) => string;
  /** Picks a wallet on the map. */
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const [read, setRead] = useState<PairRead | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<Sort>("recent");
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setRead(null);
    setError(null);
    asylApi
      .pair(a, b)
      .then((r) => live && setRead(r))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [a, b]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const coins = useMemo(() => {
    const list = [...(read?.coins ?? [])];
    if (sort === "gap") list.sort((x, y) => Math.abs(x.leadSec) - Math.abs(y.leadSec));
    if (sort === "size") list.sort((x, y) => y.a.solIn + y.b.solIn - (x.a.solIn + x.b.solIn));
    return list;
  }, [read, sort]);

  const s = read?.summary;
  const nameA = nameOf(a);
  const nameB = nameOf(b);
  const firstShare = s && s.aFirst + s.bFirst > 0 ? s.aFirst / (s.aFirst + s.bFirst) : 0.5;

  return (
    <div className="asyl-pair-scrim" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <section className="asyl-pair" role="dialog" aria-label={`Trades of ${nameA} and ${nameB}`}>
        <header className="asyl-pair-head">
          <div>
            <p className="asyl-pair-kicker">Bought together</p>
            <h2>
              <button className="asyl-pair-who a" onClick={() => onSelect(a)}>
                <span className="asyl-pair-dot a" />
                {nameA}
              </button>
              <span className="asyl-pair-amp">&amp;</span>
              <button className="asyl-pair-who b" onClick={() => onSelect(b)}>
                <span className="asyl-pair-dot b" />
                {nameB}
              </button>
            </h2>
          </div>
          <button className="asyl-icon-btn" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        {error && <p className="asyl-error">{error}</p>}
        {!read && !error && <p className="asyl-muted asyl-pair-loading">Reading their trades…</p>}

        {s && (
          <>
            <div className="asyl-pair-stats">
              <div className="asyl-pair-stat">
                <span>Coins together</span>
                <b>{s.coins}</b>
                <small>
                  of {nameA}&apos;s latest {s.of}
                </small>
              </div>
              <div className="asyl-pair-stat">
                <span>Typically apart</span>
                <b>{s.medianGapSec === null ? "–" : gapText(s.medianGapSec)}</b>
                <small>between first buys</small>
              </div>
              <div className="asyl-pair-stat wide">
                <span>Who buys first</span>
                <div className="asyl-pair-bar" aria-hidden>
                  <i className="a" style={{ width: `${firstShare * 100}%` }} />
                  <i className="b" style={{ width: `${(1 - firstShare) * 100}%` }} />
                </div>
                <small>
                  <span className="asyl-pair-a">A {s.aFirst}</span> ·{" "}
                  <span className="asyl-pair-b">B {s.bFirst}</span>
                  {s.coins - s.aFirst - s.bFirst > 0 ? ` · ${s.coins - s.aFirst - s.bFirst} same second` : ""}
                </small>
              </div>
              <div className="asyl-pair-stat">
                <span>Size</span>
                <b>{s.sizeRatio === null ? "–" : `${s.sizeRatio}×`}</b>
                <small>B&apos;s buy over A&apos;s, typically</small>
              </div>
              <div className="asyl-pair-stat wide">
                <span>Realised</span>
                <b>
                  <span className={s.netA >= 0 ? "up" : "down"}>{signed(s.netA)}</span>
                  <span className="asyl-muted"> / </span>
                  <span className={s.netB >= 0 ? "up" : "down"}>{signed(s.netB)}</span>
                </b>
                <small>SOL, A / B · both up on {s.bothUp}</small>
              </div>
              <div className="asyl-pair-stat">
                <span>Exits</span>
                <b>{s.medianExitGapSec === null ? "–" : gapText(s.medianExitGapSec)}</b>
                <small>apart, on {s.bothSold} both sold</small>
              </div>
            </div>

            <div className="asyl-pair-toolbar">
              <span className="asyl-muted asyl-small">
                {coins.length} coin{coins.length === 1 ? "" : "s"} · click one for its timeline
              </span>
              <span className="asyl-seg asyl-seg-small" role="group" aria-label="Sort">
                {(
                  [
                    ["recent", "Newest"],
                    ["gap", "Closest"],
                    ["size", "Biggest"],
                  ] as const
                ).map(([v, label]) => (
                  <button
                    key={v}
                    className={sort === v ? "on" : ""}
                    aria-pressed={sort === v}
                    onClick={() => setSort(v)}
                  >
                    {label}
                  </button>
                ))}
              </span>
            </div>

            <ol className="asyl-pair-coins">
              {coins.map((c) => {
                const first = c.leadSec > 0 ? "a" : c.leadSec < 0 ? "b" : null;
                const diff = c.b.solIn - c.a.solIn;
                const isOpen = open === c.mint;
                return (
                  <li key={c.mint} className={isOpen ? "open" : ""}>
                    <button
                      className="asyl-pair-coin"
                      onClick={() => setOpen(isOpen ? null : c.mint)}
                      aria-expanded={isOpen}
                    >
                      <span className="asyl-pair-coin-id">
                        <CoinImage coin={c} />
                        <span>
                          <b>{c.symbol ? `$${c.symbol}` : (c.name ?? c.mint.slice(0, 6))}</b>
                          <small className="asyl-muted">
                            {clock(first === "b" ? c.b.firstBuyAt : c.a.firstBuyAt)} ·{" "}
                            {c.launchedAt ? `launched ${ago(c.launchedAt)}` : ago(c.a.firstBuyAt)}
                          </small>
                        </span>
                      </span>
                      <span className={`asyl-pair-gap ${first ?? ""}`}>
                        {first
                          ? `${first.toUpperCase()} first by ${gapText(Math.abs(c.leadSec))}`
                          : "Same second"}
                      </span>
                      <span className="asyl-pair-diff" title="B's buy minus A's">
                        {diff === 0 ? "Same size" : `B ${diff > 0 ? "+" : "−"}${solText(diff)} SOL`}
                      </span>
                      <span className="asyl-pair-chev" aria-hidden>
                        ▾
                      </span>
                    </button>
                    <div className="asyl-pair-sides">
                      <SideCell s={c.a} who="a" />
                      <SideCell s={c.b} who="b" />
                    </div>
                    {isOpen && (
                      <div className="asyl-pair-detail">
                        <Timeline coin={c} />
                        <p className="asyl-muted asyl-small">
                          A above, B below; filled dots are buys, rings are sells, sized by SOL.
                          {c.exitLeadSec !== null &&
                            ` ${c.exitLeadSec > 0 ? "A" : "B"} sold first, by ${gapText(Math.abs(c.exitLeadSec))}.`}
                          {(c.a.trades.length === 0 || c.b.trades.length === 0) &&
                            " Only first buys are known for a side with no dots after its first."}
                        </p>
                        <a
                          className="asyl-link asyl-small"
                          href={`https://dexscreener.com/solana/${c.mint}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Chart on DexScreener ↗
                        </a>
                      </div>
                    )}
                  </li>
                );
              })}
            </ol>
            {coins.length === 0 && (
              <p className="asyl-muted">
                No coin of {nameA}&apos;s latest {s.of} has a buy by {nameB} within 3 minutes now; the link
                may come from an older read.
              </p>
            )}
          </>
        )}
      </section>
    </div>
  );
}
