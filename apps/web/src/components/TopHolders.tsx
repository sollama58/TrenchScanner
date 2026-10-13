import { useMemo, useState } from "react";
import type { Snapshot } from "../api";
import { shortAddress } from "../format";
import { buildGraph, type FlaggedHolder } from "../bubbleMap";
import { openWallet } from "../walletModal";
import { CLUSTER_COLOURS } from "./BubbleMap";

/** Holders listed before "Show all". */
const SHOWN = 12;

/**
 * The token modal's top-holder list: each holder the linked reading covered, largest first, with
 * its share as a bar, the colour of the cluster one funder paid for (the bubble map's), and what
 * the wallet is (dev, risky, known dumper). Read from the same graph the bubble map draws, so the
 * two always agree. Nothing when the scan kept no holder list.
 */
export function TopHolders({
  snapshot,
  flagged,
}: {
  snapshot: Snapshot | null;
  flagged: readonly FlaggedHolder[];
}) {
  const [all, setAll] = useState(false);
  const graph = useMemo(() => (snapshot ? buildGraph(snapshot, flagged) : null), [snapshot, flagged]);
  const holders = useMemo(
    () => (graph ? graph.nodes.filter((n) => n.kind === "holder").sort((a, b) => b.pct - a.pct) : []),
    [graph],
  );
  if (!graph || holders.length === 0) return null;
  const rest = graph.nodes.find((n) => n.kind === "rest");
  const max = Math.max(...holders.map((h) => h.pct), rest?.pct ?? 0);
  const shown = all ? holders : holders.slice(0, SHOWN);
  const total = holders.reduce((s, h) => s + h.pct, 0) + (rest?.pct ?? 0);
  return (
    <section className="sage-card tm-holders-card">
      <h4>
        Top holders
        <span className="sage-tag">{holders.length + (rest?.count ?? 0)}</span>
        {graph.top10Pct !== null && (
          <span
            className="tm-h4-meta muted small num"
            title="Share of supply the top holders own, pool aside"
          >
            {graph.top10Pct.toFixed(1)}% held
          </span>
        )}
      </h4>
      <ol className="th-list">
        {shown.map((h, i) => {
          const cluster = h.cluster === null ? null : graph.clusters[h.cluster];
          const colour = h.cluster === null ? "var(--bm-none)" : `var(--bm-${h.cluster % CLUSTER_COLOURS})`;
          return (
            <li key={h.id} className="th-row">
              <span className="th-rank num">{i + 1}</span>
              <span className="th-who">
                <i
                  className="th-dot"
                  style={{ background: colour, opacity: h.cluster === null ? 0.55 : 1 }}
                  title={
                    cluster ? `Funded by ${shortAddress(cluster.funder)}` : "Linked to no other top holder"
                  }
                />
                <button
                  type="button"
                  className="num th-wallet tm-wallet-btn"
                  onClick={() => h.wallet && openWallet(h.wallet)}
                  title="Open this wallet's details"
                >
                  {shortAddress(h.wallet ?? "")}
                </button>
                {h.flags.includes("creator") && <span className="tm-tag k-dev">Dev</span>}
                {h.flags.includes("risky") && <span className="tm-tag k-risky">Risky</span>}
                {h.flags.includes("dumper") && <span className="tm-tag k-risky">Dumper</span>}
                {h.hub && <span className="tm-tag k-linked">Funder</span>}
              </span>
              <span className="th-bar" aria-hidden="true">
                <span style={{ width: `${Math.max(3, (h.pct / max) * 100)}%`, background: colour }} />
              </span>
              <span className="th-pct num">{h.pct < 10 ? h.pct.toFixed(2) : h.pct.toFixed(1)}%</span>
            </li>
          );
        })}
        {rest && (all || holders.length <= SHOWN) && (
          <li className="th-row th-rest">
            <span className="th-rank num">…</span>
            <span className="th-who muted">
              {rest.count} other{rest.count === 1 ? "" : "s"} together
            </span>
            <span className="th-bar" aria-hidden="true">
              <span style={{ width: `${Math.max(3, (rest.pct / max) * 100)}%` }} />
            </span>
            <span className="th-pct num muted">{rest.pct.toFixed(1)}%</span>
          </li>
        )}
      </ol>
      {holders.length > SHOWN && (
        <button type="button" className="tm-link tm-more" onClick={() => setAll((a) => !a)}>
          {all ? "Show fewer" : `Show all ${holders.length}`}
        </button>
      )}
      <p className="faint small th-note">
        Pool aside. The dot is the holder&apos;s cluster in the bubble map; grey is linked to no other holder.
        {total > 0 &&
          graph.linkedPct !== null &&
          (graph.linkedCount
            ? ` ${graph.linkedCount.linked} of the ${graph.linkedCount.of} top holders are linked, holding ${graph.linkedPct.toFixed(1)}% of supply.`
            : ` ${graph.linkedPct.toFixed(1)}% of supply is linked.`)}
      </p>
    </section>
  );
}
