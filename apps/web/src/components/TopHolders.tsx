import { Fragment, useId, useMemo, useState } from "react";
import type { Snapshot } from "../api";
import {
  buildGraph,
  CLOCK_ICON,
  nodeSlot,
  sameTimeSlot,
  transfersOfNode,
  type FlaggedHolder,
} from "../bubbleMap";
import { entryParts, entryTitle, type HolderEntry } from "../holderEntry";
import { possibleSideText, usePossibleSides } from "../possibleSides";
import { openWallet } from "../walletModal";
import { useWalletNames, walletText } from "../walletNames";
import { TRAIT_WORDS, TraitIcon, transferWords } from "./BubbleMap";
import { FoldHead } from "./Fold";
import { TransferIcon } from "./Icons";
import { WalletText } from "./WalletText";

/** Holders listed before "Show all". */
const SHOWN = 12;

/**
 * The token modal's top-holder list: each holder the linked reading covered, largest first, with
 * its share as a bar, the colour of the cluster one funder paid for (the bubble map's), and what
 * the wallet is (dev, risky, known dumper). Read from the same graph the bubble map draws, so the
 * two always agree. Nothing when the scan kept no holder list. Folded to its heading until opened
 * (user ask 2026-10-16): the bubble map above already shows who holds what.
 *
 * Each row also carries the bubble map's marks (user ask 2026-10-17): the wallet type (sniper,
 * fresh, empty), the same-minute clock in its group's colour, a transfer mark when it moved the
 * coin to or from another top holder, the KOL, side and Winner labels, and a line on how it got in
 * from the trade tape (holder entries, on coins whose trades were read).
 */
export function TopHolders({
  snapshot,
  flagged,
  entries = {},
  pending = false,
}: {
  snapshot: Snapshot | null | undefined;
  flagged: readonly FlaggedHolder[];
  /** How each holder got in, by wallet (the chart's holderEntries); empty until the tape is read. */
  entries?: Readonly<Record<string, HolderEntry>>;
  /** A fresh scan is reading the holders now: the list's place is held until it lands. */
  pending?: boolean;
}) {
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const graph = useMemo(() => (snapshot ? buildGraph(snapshot, flagged) : null), [snapshot, flagged]);
  const holders = useMemo(
    () => (graph ? graph.nodes.filter((n) => n.kind === "holder").sort((a, b) => b.pct - a.pct) : []),
    [graph],
  );
  // One read names every holder and funder on the list (KOLs, exchanges, named services).
  const names = useWalletNames(
    useMemo(
      () => [...holders.map((h) => h.wallet), ...(graph?.clusters.map((c) => c.funder) ?? [])],
      [holders, graph],
    ),
  );
  // The bubble map reads the same wallets: one read, kept for the session, serves both.
  const sides = usePossibleSides(useMemo(() => holders.map((h) => h.wallet), [holders]));
  const byWallet = useMemo(() => new Map(flagged.map((w) => [w.wallet, w])), [flagged]);
  if (!graph || holders.length === 0) {
    if (!pending) return null;
    return (
      <section className="sage-card tm-holders-card" aria-busy="true">
        <h4>Top holders</h4>
        <ol className="th-list th-skeleton" aria-hidden="true">
          {Array.from({ length: SHOWN }, (_, i) => (
            <li key={i} className="th-row">
              <span className="th-rank num">{i + 1}</span>
              <span className="skeleton skel-value" style={{ width: `${46 - ((i * 7) % 18)}%` }} />
              <span className="skeleton skel-value" style={{ width: "3em", marginLeft: "auto" }} />
            </li>
          ))}
        </ol>
      </section>
    );
  }
  const rest = graph.nodes.find((n) => n.kind === "rest");
  const max = Math.max(...holders.map((h) => h.pct), rest?.pct ?? 0);
  const shown = all ? holders : holders.slice(0, SHOWN);
  const total = holders.reduce((s, h) => s + h.pct, 0) + (rest?.pct ?? 0);
  return (
    <section className={`sage-card tm-holders-card${open ? "" : " folded"}`}>
      <FoldHead open={open} onToggle={() => setOpen((o) => !o)} controls={bodyId}>
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
      </FoldHead>
      {open && (
        <div id={bodyId}>
          <ol className="th-list">
            {shown.map((h, i) => {
              const cluster = h.cluster === null ? null : graph.clusters[h.cluster];
              const slot = nodeSlot(h, graph);
              const colour = slot === null ? "var(--bm-none)" : `var(--bm-${slot})`;
              const same = h.sameTime === null ? null : graph.sameTimeGroups[h.sameTime];
              const moved = transferWords(transfersOfNode(graph, h.id));
              const f = h.wallet ? byWallet.get(h.wallet) : undefined;
              const named = h.wallet ? names[h.wallet] : undefined;
              const side = !!f?.knownSideOf || named?.source === "kol-side";
              const kol =
                !side &&
                (typeof h.kol === "string" || named?.source === "kol" || named?.source === "tracked");
              const possible = (h.wallet ? (sides[h.wallet] ?? []) : []).filter((p) => !(side && p.known));
              const entry = h.wallet ? entries[h.wallet] : undefined;
              return (
                <li key={h.id} className="th-row">
                  <span className="th-rank num">{i + 1}</span>
                  <span className="th-who">
                    <i
                      className="th-dot"
                      style={{ background: colour, opacity: slot === null ? 0.55 : 1 }}
                      title={
                        cluster
                          ? `Funded by ${walletText(cluster.funder, names)}`
                          : same
                            ? "Linked to no other top holder by funder; funded the same minute as others"
                            : "Linked to no other top holder"
                      }
                    />
                    <button
                      type="button"
                      className="th-wallet tm-wallet-btn"
                      onClick={() => h.wallet && openWallet(h.wallet)}
                      title="Open this wallet's details"
                    >
                      <WalletText wallet={h.wallet} names={names} />
                    </button>
                    {(h.trait || same || moved.length > 0) && (
                      <span className="th-marks">
                        {h.trait && (
                          <span className="th-mark" title={TRAIT_WORDS[h.trait]}>
                            <TraitIcon trait={h.trait} size={14} />
                          </span>
                        )}
                        {same && h.sameTime !== null && (
                          <span
                            className="th-mark th-clock"
                            style={{ color: `var(--bm-${sameTimeSlot(graph, h.sameTime)})` }}
                            title={`Funded the same minute as ${same.wallets.length - 1} other top holder${
                              same.wallets.length === 2 ? "" : "s"
                            } (this colour on the map)`}
                          >
                            <svg
                              className="bm-trait-icon"
                              viewBox="0 0 24 24"
                              width={14}
                              height={14}
                              aria-hidden
                            >
                              {CLOCK_ICON.map((d) => (
                                <path key={d} d={d} />
                              ))}
                            </svg>
                          </span>
                        )}
                        {moved.length > 0 && (
                          <span
                            className="th-mark th-xfer"
                            title={`Transfers with other top holders: ${moved.join(", ")}`}
                          >
                            <TransferIcon size={14} />
                          </span>
                        )}
                      </span>
                    )}
                    {h.flags.includes("creator") && <span className="tm-tag k-dev">Dev</span>}
                    {h.flags.includes("risky") && (
                      <span
                        className="tm-tag k-risky"
                        title={h.score !== null ? `Risk score ${Math.round(h.score)} of 100` : undefined}
                      >
                        Risky
                      </span>
                    )}
                    {h.flags.includes("dumper") && (
                      <span
                        className="tm-tag k-risky"
                        title={
                          h.dumps !== null
                            ? `Sold into the stop on ${h.dumps} of its alerted coins`
                            : undefined
                        }
                      >
                        Dumper
                      </span>
                    )}
                    {h.creatorTied && !h.flags.includes("creator") && (
                      <span
                        className="tm-tag k-dev"
                        title="The creator or its funder paid for this wallet, or it got SOL or the coin from one that was"
                      >
                        Tied to dev
                      </span>
                    )}
                    {kol && (
                      <span className="tm-tag k-kol">{named?.source === "tracked" ? "Tracked" : "KOL"}</span>
                    )}
                    {side && <span className="tm-tag k-side">Known Side</span>}
                    {possible.map((p) => (
                      <span key={p.kolWallet} className="tm-tag k-side">
                        {possibleSideText(p)}
                      </span>
                    ))}
                    {f?.tags.includes("winner") && (
                      <span
                        className="tm-tag k-winner"
                        title="Took 2x or better out of 3+ coins it bought, at least twice as often as the market"
                      >
                        Winner
                      </span>
                    )}
                    {h.hub && <span className="tm-tag k-linked">Funder</span>}
                    {entry && (
                      <span className="th-entry muted" title={entryTitle(entry)}>
                        {entryParts(entry).map((part, k) => (
                          <Fragment key={k}>
                            {k > 0 && " · "}
                            <span>{part}</span>
                          </Fragment>
                        ))}
                      </span>
                    )}
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
            {graph.linkedPct === null
              ? "Pool aside. Who funded these holders isn't checked yet, so none are grouped into clusters."
              : "Pool aside. The dot is the holder's cluster in the bubble map; grey is linked to no other holder."}
            {Object.keys(entries).length === 0 &&
              " How each holder got in shows once the coin's trades are read, which happens for alerted coins."}
            {total > 0 &&
              graph.linkedPct !== null &&
              (graph.linkedCount
                ? ` ${graph.linkedCount.linked} of the ${graph.linkedCount.of} top holders are linked, holding ${graph.linkedPct.toFixed(1)}% of supply.`
                : ` ${graph.linkedPct.toFixed(1)}% of supply is linked.`)}
          </p>
        </div>
      )}
    </section>
  );
}
