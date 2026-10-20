import { useEffect, useState } from "react";
import { setAppearance, useAppearance } from "../appearance";
import { clampMinSol, MARK_KINDS, MIN_SOL_FLOOR, type MarkKind } from "../walletMarks";

/** The Customize section's id: the token chart's "Wallet trades" link scrolls to it. */
export const CHART_MARKS_SECTION = "customize-chart-marks";

/**
 * Customize › Chart wallet trades (user ask 2026-10-18): whether the token chart marks labeled
 * wallets' trades, which kinds of wallet, the smallest trade it marks (never under MIN_SOL_FLOOR
 * SOL), and how those marks look. Saved with the feed's appearance, so every device marks the same.
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
      <label className="check">
        <input
          type="checkbox"
          checked={look.chartMarkPics}
          disabled={!on}
          onChange={() => setAppearance({ chartMarkPics: !look.chartMarkPics })}
        />
        Show KOLs by their X pictures
      </label>
      <div className={`cm-scale${on ? "" : " off"}`}>
        <span>Mark size</span>
        <div className="segmented small" role="radiogroup" aria-label="Trade mark size">
          {(
            [
              ["s", "Small"],
              ["m", "Medium"],
              ["l", "Large"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={look.chartMarkScale === id}
              className={look.chartMarkScale === id ? "on" : ""}
              disabled={!on}
              title={
                id === "s"
                  ? "Smaller marks and pictures"
                  : id === "l"
                    ? "Larger marks and pictures"
                    : "The usual size"
              }
              onClick={() => setAppearance({ chartMarkScale: id })}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className={`cm-scale${on ? "" : " off"}`}>
        <span>Shape</span>
        <div className="segmented small" role="radiogroup" aria-label="Trade mark shape">
          {(
            [
              ["circle", "Circle", "A ring, the usual mark"],
              ["square", "Square", "A square"],
              ["diamond", "Diamond", "A diamond"],
            ] as const
          ).map(([id, label, title]) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={look.chartMarkShape === id}
              className={look.chartMarkShape === id ? "on" : ""}
              disabled={!on}
              title={title}
              onClick={() => setAppearance({ chartMarkShape: id })}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <label className="check">
        <input
          type="checkbox"
          checked={look.chartMarkStem}
          disabled={!on}
          onChange={() => setAppearance({ chartMarkStem: !look.chartMarkStem })}
        />
        Line to the candle
      </label>
      <div className={`cm-scale${on ? "" : " off"}`}>
        <span>Distance</span>
        <div className="segmented small" role="radiogroup" aria-label="Distance from the candle">
          {(
            [
              ["s", "Small", "Closer to the candle"],
              ["m", "Medium", "The usual distance from the candle"],
              ["l", "Large", "Farther from the candle"],
            ] as const
          ).map(([id, label, title]) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={look.chartMarkGap === id}
              className={look.chartMarkGap === id ? "on" : ""}
              disabled={!on}
              title={title}
              onClick={() => setAppearance({ chartMarkGap: id })}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <p className="faint small check-hint">
        Buys hang under the price and sales sit over it, bigger for more SOL. A filled mark is a buy, a hollow
        one a sale. Circle, square and diamond are the lettered wallet marks; a KOL&apos;s picture stays
        round, and your own buys and sells stay arrows. Mark size scales the marks. Distance is how far they
        sit from the candle, separate from that size. The line to the candle is off unless you turn it on.
        Click a mark to open the wallet. Never under {MIN_SOL_FLOOR} SOL.
      </p>
    </div>
  );
}
