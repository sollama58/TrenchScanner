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
