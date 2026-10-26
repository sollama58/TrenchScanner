import { useEffect, useState } from "react";
import { ago } from "../format";
import { asylApi, type CoinReport } from "./asylApi";
import { shortAddr } from "./graph";

const pct = (n: number | null | undefined) =>
  n === null || n === undefined ? "–" : `${n >= 10 ? n.toFixed(0) : n.toFixed(1)}%`;
const sol = (n: number) => `${n >= 100 ? n.toFixed(0) : n.toFixed(2)} SOL`;
const gapText = (from: string, to: string) => {
  const s = Math.round((Date.parse(to) - Date.parse(from)) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};
const of = (n: number | null, d: number | null) => (n === null ? "–" : d ? `${n}/${d}` : String(n));

/** The holders-over-time lines, drawn and keyed in this order. */
const LINES = [
  { key: "top10", label: "Top 10", color: "var(--asyl-orange)" },
  { key: "largest", label: "Largest", color: "var(--asyl-orange-hi)" },
  { key: "bundled", label: "Linked", color: "var(--asyl-bad)" },
] as const;

/** Holder concentration at each scan: one line per reading, time across, % of supply up. */
function ConcentrationChart({ points }: { points: CoinReport["concentration"] }) {
  const W = 260;
  const H = 84;
  const t0 = Date.parse(points[0]!.at);
  const span = Math.max(1, Date.parse(points[points.length - 1]!.at) - t0);
  const top = Math.max(
    20,
    Math.ceil(Math.max(...points.flatMap((p) => LINES.map((l) => p[l.key] ?? 0))) / 10) * 10,
  );
  const x = (at: string) => ((Date.parse(at) - t0) / span) * (W - 4) + 2;
  const y = (v: number) => H - 2 - (v / top) * (H - 4);
  const last = points[points.length - 1]!;
  const firstHolders = points.find((p) => p.holders !== null)?.holders ?? null;
  return (
    <figure className="asyl-conc">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Holder concentration over time">
        {[0.5, 1].map((f) => (
          <line key={f} x1={0} x2={W} y1={y(top * f)} y2={y(top * f)} className="asyl-conc-grid" />
        ))}
        <text x={W - 2} y={y(top) + 9} textAnchor="end" className="asyl-conc-axis">
          {top}%
        </text>
        {LINES.map((l) => {
          const pts = points.filter((p) => p[l.key] !== null);
          if (pts.length === 0) return null;
          return pts.length === 1 ? (
            <circle key={l.key} cx={x(pts[0]!.at)} cy={y(pts[0]![l.key]!)} r={2.5} fill={l.color} />
          ) : (
            <polyline
              key={l.key}
              fill="none"
              stroke={l.color}
              strokeWidth={1.6}
              strokeLinejoin="round"
              points={pts.map((p) => `${x(p.at).toFixed(1)},${y(p[l.key]!).toFixed(1)}`).join(" ")}
            />
          );
        })}
      </svg>
      <figcaption>
        {LINES.filter((l) => points.some((p) => p[l.key] !== null)).map((l) => {
          const now = [...points].reverse().find((p) => p[l.key] !== null)![l.key];
          return (
            <span key={l.key}>
              <i style={{ background: l.color }} /> {l.label} {pct(now)}
            </span>
          );
        })}
        {last.holders !== null && (
          <span className="asyl-muted">
            {last.holders.toLocaleString()} holders
            {firstHolders !== null && firstHolders !== last.holders
              ? ` (from ${firstHolders.toLocaleString()})`
              : ""}
          </span>
        )}
      </figcaption>
      <p className="asyl-muted asyl-small">
        {points.length} scans, {ago(points[0]!.at)} to {ago(last.at)}.
      </p>
    </figure>
  );
}

const FLOW_LABEL: Record<CoinReport["flow"][number]["group"], string> = {
  dev: "Dev",
  sniper: "Snipers (first 5s)",
  early: "Other first 25",
  top: "Top 10 holders",
  rest: "Everyone else",
};

/** SOL in and out of the coin by wallet group: two bars each, on one scale, and what they made. */
function MoneyFlow({ rows }: { rows: CoinReport["flow"] }) {
  const most = Math.max(...rows.flatMap((r) => [r.solIn, r.solOut]), 0.0001);
  const w = (n: number) => `${Math.max(n > 0 ? 2 : 0, (n / most) * 100)}%`;
  return (
    <>
      <ul className="asyl-flow">
        {rows.map((r) => {
          const net = r.solOut - r.solIn;
          return (
            <li key={r.group}>
              <div className="asyl-flow-head">
                <span>
                  {FLOW_LABEL[r.group]}
                  <span className="asyl-muted">
                    {" "}
                    · {r.wallets} wallet{r.wallets === 1 ? "" : "s"}
                  </span>
                </span>
                <span
                  className={net > 0 ? "good" : net < 0 ? "bad" : "asyl-muted"}
                  title={
                    net < 0
                      ? "Taken out less than put in so far. What they still hold isn't counted, so this is not yet a loss."
                      : "Taken out more than put in"
                  }
                >
                  {net > 0 ? "+" : net < 0 ? "−" : ""}
                  {sol(Math.abs(net))}
                  {net < 0 && <span className="asyl-muted"> so far</span>}
                </span>
              </div>
              <div className="asyl-flow-bar in" title={`Put in ${sol(r.solIn)}`}>
                <i style={{ width: w(r.solIn) }} />
                <span>in {sol(r.solIn)}</span>
              </div>
              <div className="asyl-flow-bar out" title={`Took out ${sol(r.solOut)}`}>
                <i style={{ width: w(r.solOut) }} />
                <span>out {sol(r.solOut)}</span>
              </div>
            </li>
          );
        })}
      </ul>
      <p className="asyl-muted asyl-small">
        From the coin&apos;s trade tape; each wallet counts once, in its first group. Out includes only what
        was sold, not what is still held.
      </p>
    </>
  );
}

const TONE: Record<CoinReport["verdict"]["level"], string> = {
  high: "bad",
  some: "warn",
  low: "good",
  unknown: "",
};

/**
 * A coin's report in the inspector (user ask 2026-10-26): is it bundled, who sniped it, and how
 * did its dev's other coins go. Each part has a button that puts what it counts on the map.
 */
export function CoinReportCard({
  mint,
  busy,
  nameOf,
  onEarlyBuyers,
  onLaunches,
  onWave,
  onSelect,
}: {
  mint: string;
  busy: boolean;
  nameOf: (id: string) => string | null;
  onEarlyBuyers: (mint: string) => void;
  onLaunches: (wallet: string) => void;
  onWave: (wallets: string[], mint: string) => void;
  onSelect: (id: string) => void;
}) {
  const [report, setReport] = useState<CoinReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setReport(null);
    setError(null);
    let live = true;
    asylApi
      .report(mint)
      .then((r) => live && setReport(r))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [mint]);

  if (error) return <p className="asyl-muted asyl-small">Couldn&apos;t read its report: {error}</p>;
  if (!report)
    return <p className="asyl-muted asyl-small">Checking for bundles and the dev&apos;s history…</p>;
  const { launch, scan, dev } = report;
  const grouped = launch?.groups.reduce((n, g) => n + g.wallets.length, 0) ?? 0;
  const counts = dev
    ? dev.coins.reduce(
        (c, x) => ({ ...c, [x.outcome ?? "unknown"]: (c[x.outcome ?? "unknown"] ?? 0) + 1 }),
        {} as Record<string, number>,
      )
    : {};

  return (
    <>
      <section className="asyl-insp-section asyl-report">
        <h3>Bundle check</h3>
        <p className={`asyl-verdict ${TONE[report.verdict.level]}`}>{report.verdict.text}</p>
        <dl className="asyl-facts">
          {scan?.bundledPct != null && (
            <>
              <dt>Linked holders</dt>
              <dd title="Supply held by top holders that one funder paid, that funded one another, or that sit in a KOL's bundle">
                {pct(scan.bundledPct)} · {of(scan.bundledCount, scan.holdersChecked)} wallets
              </dd>
            </>
          )}
          {scan?.blockZeroBuyers != null && (
            <>
              <dt>Block 0</dt>
              <dd title="Wallets that bought in the create transaction's own slot">
                {scan.blockZeroBuyers} bought {pct(scan.blockZeroBoughtPct)}, hold{" "}
                {pct(scan.blockZeroHeldPct)}
              </dd>
            </>
          )}
          {scan?.snipersInTop != null && (
            <>
              <dt>Snipers in top</dt>
              <dd>{of(scan.snipersInTop, scan.topChecked)}</dd>
            </>
          )}
          {scan?.freshInTop != null && (
            <>
              <dt>Fresh in top</dt>
              <dd title="Top holders on wallets with almost no history">
                {of(scan.freshInTop, scan.freshChecked)}
              </dd>
            </>
          )}
          {scan?.cexFundedPct != null && (
            <>
              <dt>Exchange-funded</dt>
              <dd>{pct(scan.cexFundedPct)}</dd>
            </>
          )}
          {launch && (
            <>
              <dt>First buyers</dt>
              <dd>
                {launch.buyers.length} · {launch.snipers} in the first 5s · {launch.soldCount} sold
              </dd>
              <dt>They held</dt>
              <dd>{pct(launch.heldPct)} of supply</dd>
              {grouped > 0 && (
                <>
                  <dt>Shared funder</dt>
                  <dd>
                    {launch.groups.map((g, i) => (
                      <span key={g.funder}>
                        {i > 0 && ", "}
                        {g.wallets.length} by{" "}
                        <button className="asyl-link" onClick={() => onSelect(g.funder)}>
                          {nameOf(g.funder) ?? shortAddr(g.funder)}
                        </button>
                      </span>
                    ))}
                  </dd>
                </>
              )}
            </>
          )}
        </dl>
        {scan && <p className="asyl-muted asyl-small">Scan readings from {ago(scan.at)}.</p>}
        {launch && (
          <button className="asyl-btn" disabled={busy} onClick={() => onEarlyBuyers(mint)}>
            Show first buyers and their funders
          </button>
        )}
      </section>

      {report.flow.length > 0 && (
        <section className="asyl-insp-section asyl-report">
          <h3>Money in and out</h3>
          <MoneyFlow rows={report.flow} />
        </section>
      )}

      {report.concentration.length > 0 && (
        <section className="asyl-insp-section asyl-report">
          <h3>Holders over time</h3>
          <ConcentrationChart points={report.concentration} />
        </section>
      )}

      {report.waves.length > 0 && (
        <section className="asyl-insp-section asyl-report">
          <h3>Sold together</h3>
          <p className="asyl-muted asyl-small">
            Wallets whose first sells came within a minute of each other.
          </p>
          <ul className="asyl-report-waves">
            {report.waves.map((w) => (
              <li key={w.from}>
                <span>
                  <b>{w.wallets.length} wallets</b> in {gapText(w.from, w.to)} · {sol(w.sol)} out
                  <span className="asyl-muted"> · {ago(w.from)}</span>
                </span>
                <button
                  className="asyl-btn ghost small"
                  disabled={busy}
                  onClick={() => onWave(w.wallets, mint)}
                >
                  Show
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {dev && (
        <section className="asyl-insp-section asyl-report">
          <h3>Dev history</h3>
          <dl className="asyl-facts">
            <dt>Dev</dt>
            <dd>
              <button className="asyl-link" onClick={() => onSelect(dev.wallet)}>
                {nameOf(dev.wallet) ?? shortAddr(dev.wallet)}
              </button>
              {dev.risk !== null && <span className="asyl-muted"> · risk {Math.round(dev.risk)}/100</span>}
            </dd>
            <dt>Other coins</dt>
            <dd>
              {dev.coins.length === 0
                ? "None TrenchScanner knows of"
                : [
                    `${dev.coins.length}${dev.coins.length >= 12 ? "+" : ""}`,
                    counts.win ? `${counts.win} won` : null,
                    counts.stop ? `${counts.stop} dumped` : null,
                    counts.fizzle ? `${counts.fizzle} fizzled` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
            </dd>
            {dev.launch && (
              <>
                <dt>Launch score</dt>
                <dd className={dev.launch.score >= 60 ? "bad" : dev.launch.score <= 30 ? "good" : ""}>
                  {Math.round(dev.launch.score)}/100 over {dev.launch.launches} launches
                </dd>
              </>
            )}
            {dev.family && (
              <>
                <dt>Its funder</dt>
                <dd>
                  paid {dev.family.creators} devs, {dev.family.launches} launches, {dev.family.wins} won
                </dd>
              </>
            )}
            <dt>This coin</dt>
            <dd className={dev.thisCoin?.sold ? "bad" : ""}>
              {dev.thisCoin
                ? dev.thisCoin.sold
                  ? `Sold ${sol(dev.thisCoin.solOut)}${dev.thisCoin.firstSellAt ? `, first ${ago(dev.thisCoin.firstSellAt)}` : ""}`
                  : `Bought ${sol(dev.thisCoin.solIn)}, hasn't sold`
                : scan?.devHolding === false
                  ? "No longer holds it"
                  : scan?.devHolding
                    ? "Still holds it"
                    : "Not seen trading it"}
            </dd>
          </dl>
          {dev.coins.length > 0 && (
            <ul className="asyl-report-coins">
              {dev.coins.slice(0, 6).map((c) => (
                <li key={c.mint}>
                  <span>{c.symbol ? `$${c.symbol}` : shortAddr(c.mint)}</span>
                  <span
                    className={c.outcome === "win" ? "good" : c.outcome === "stop" ? "bad" : "asyl-muted"}
                  >
                    {c.outcome === "win"
                      ? "won"
                      : c.outcome === "stop"
                        ? "dumped"
                        : c.outcome === "fizzle"
                          ? "fizzled"
                          : "ungraded"}
                    {c.peakPct !== null && c.peakPct > 0 ? ` · peak +${Math.round(c.peakPct)}%` : ""}
                  </span>
                  <span className="asyl-muted">{ago(c.at)}</span>
                </li>
              ))}
            </ul>
          )}
          <button className="asyl-btn" disabled={busy} onClick={() => onLaunches(dev.wallet)}>
            Show the dev&apos;s coins
          </button>
        </section>
      )}
    </>
  );
}
