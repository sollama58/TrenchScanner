import { useEffect, useState } from "react";
import { setAppearance, useAppearance } from "../appearance";
import { clampMinSol, MARK_KINDS, MIN_SOL_FLOOR, type MarkKind } from "../walletMarks";

/** The Customize section's id: the token chart's "Wallet trades" link scrolls to it. */
export const CHART_MARKS_SECTION = "customize-chart-marks";

/**
 * Customize › Chart wallet trades (user ask 2026-10-18): whether the token chart marks labeled
 * wallets' trades, which kinds of wallet, and the smallest trade it marks (never under
 * MIN_SOL_FLOOR SOL). Saved with the feed's appearance, so every device marks the same.
 */
export function WalletMarksPicker() {
  const look = useAppearance();
  const on = look.chartMarks;
  // The size field keeps what is typed until it is left, then settles on the clamped value.
  const [draft, setDraft] = useState(String(look.chartMarkMinSol));
  useEffect(() => setDraft(String(look.chartMarkMinSol)), [look.chartMarkMinSol]);
  const toggle = (kind: MarkKind) => {
    const has = look.chartMarkKinds.includes(kind);
    setAppearance({
      chartMarks: true,
      chartMarkKinds: MARK_KINDS.map((k) => k.kind).filter((k) =>
        k === kind ? !has : look.chartMarkKinds.includes(k),
      ),
    });
  };
  const commit = () => {
    const minSol = clampMinSol(draft);
    setDraft(String(minSol));
    if (minSol !== look.chartMarkMinSol) setAppearance({ chartMarkMinSol: minSol });
  };

  return (
    <div className="field-group cm-panel" id={CHART_MARKS_SECTION} tabIndex={-1}>
      <h4>Chart wallet trades</h4>
      <label className="check">
        <input type="checkbox" checked={on} onChange={() => setAppearance({ chartMarks: !on })} />
        Mark trades by KOLs, their sides and flagged wallets on token charts
      </label>
      <div className={`cm-kinds${on ? "" : " off"}`} role="group" aria-label="Kinds of wallet to mark">
        {MARK_KINDS.map((k) => {
          const shown = look.chartMarkKinds.includes(k.kind);
          return (
            <button
              key={k.kind}
              type="button"
              className={`cm-kind wk-${k.kind}${shown ? " on" : ""}`}
              aria-pressed={shown}
              title={k.title}
              disabled={!on}
              onClick={() => toggle(k.kind)}
            >
              <i className="cm-letter" aria-hidden="true">
                {k.letter}
              </i>
              {k.label}
            </button>
          );
        })}
      </div>
      <label className="cm-size">
        Trades of at least
        <input
          type="number"
          inputMode="decimal"
          min={MIN_SOL_FLOOR}
          step={0.25}
          value={draft}
          disabled={!on}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === "Enter" && commit()}
        />
        SOL
      </label>
      <p className="faint small check-hint">
        A filled ring is a buy, a hollow one a sale, bigger for more SOL. Never under {MIN_SOL_FLOOR} SOL.
      </p>
    </div>
  );
}
