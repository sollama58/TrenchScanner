import { useEffect, useState } from "react";
import {
  clampMinSol,
  DEFAULT_MIN_SOL,
  kindsOf,
  MARK_KINDS,
  MIN_SOL_FLOOR,
  type MarkKind,
  type MarkPrefs,
  type MarkSource,
} from "../walletMarks";

/**
 * The token chart's labeled-wallet trades setting (user ask 2026-10-18): marks on or off, which
 * kinds of wallet show, and the smallest trade that does (never under MIN_SOL_FLOOR SOL). Each
 * kind says how many of the coin's labeled wallets it covers, so an empty one reads as empty.
 */
export function WalletMarksPicker({
  prefs,
  onChange,
  wallets,
  shown,
}: {
  prefs: MarkPrefs;
  onChange: (p: MarkPrefs) => void;
  wallets: readonly MarkSource[];
  /** How many trades are marked under the current setting. */
  shown: number;
}) {
  // The size field keeps what is typed until it is left, then settles on the clamped value.
  const [draft, setDraft] = useState(String(prefs.minSol));
  useEffect(() => setDraft(String(prefs.minSol)), [prefs.minSol]);
  const counts = new Map<MarkKind, number>();
  for (const w of wallets) for (const k of kindsOf(w)) counts.set(k, (counts.get(k) ?? 0) + 1);
  const toggle = (kind: MarkKind) => {
    const has = prefs.kinds.includes(kind);
    const kinds = MARK_KINDS.map((k) => k.kind).filter((k) => (k === kind ? !has : prefs.kinds.includes(k)));
    onChange({ ...prefs, on: true, kinds });
  };
  const commit = () => {
    const minSol = clampMinSol(draft === "" ? DEFAULT_MIN_SOL : draft);
    setDraft(String(minSol));
    if (minSol !== prefs.minSol) onChange({ ...prefs, minSol });
  };

  return (
    <div className="cm-panel" role="group" aria-label="Labeled wallet trades on the chart">
      <label className="cm-switch">
        <input
          type="checkbox"
          checked={prefs.on}
          onChange={(e) => onChange({ ...prefs, on: e.target.checked })}
        />
        <span>Show labeled wallet trades</span>
      </label>
      <div className={`cm-kinds${prefs.on ? "" : " off"}`}>
        {MARK_KINDS.map((k) => {
          const on = prefs.kinds.includes(k.kind);
          const n = counts.get(k.kind) ?? 0;
          return (
            <button
              key={k.kind}
              type="button"
              className={`cm-kind wk-${k.kind}${on ? " on" : ""}`}
              aria-pressed={on}
              title={`${k.title}: ${n} in this coin`}
              disabled={!prefs.on}
              onClick={() => toggle(k.kind)}
            >
              <i className="cm-letter" aria-hidden="true">
                {k.letter}
              </i>
              {k.label}
              <span className="cm-count num">{n}</span>
            </button>
          );
        })}
      </div>
      <div className="cm-foot">
        <label className="cm-size">
          Trades of at least
          <input
            type="number"
            inputMode="decimal"
            min={MIN_SOL_FLOOR}
            step={0.25}
            value={draft}
            disabled={!prefs.on}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => e.key === "Enter" && commit()}
          />
          SOL
        </label>
        <span className="faint small">
          {prefs.on ? `${shown} marked` : "Hidden"} · filled ring a buy, hollow a sale · never under{" "}
          {MIN_SOL_FLOOR} SOL
        </span>
      </div>
    </div>
  );
}
