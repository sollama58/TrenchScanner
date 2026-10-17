import { useState } from "react";
import type { MarketLighthouse } from "../api";
import { ago } from "../format";
import { ShareIcon } from "./Icons";
import { ShareImageDialog } from "./ShareImageDialog";
import { renderSafetyCard, sinceUtc, splitPctText } from "./safetyCard";

type SafetyScreen = NonNullable<MarketLighthouse["safetyScreen"]>;

/**
 * The Lighthouse's safety-screen scale: of every token the scanner checked in the window, the
 * share that cleared the safety screen against the share it turned away, which the Lighthouse
 * calls Probable Rugs. One track, accepted filling from the left and Probable Rugs from the right,
 * with a knob at the split, and a share image of the same.
 */
export function SafetyGauge({ s, span, days }: { s: SafetyScreen; span: string; days: number }) {
  const [sharing, setSharing] = useState(false);
  const total = s.accepted + s.rejected;
  const rugPct = total > 0 ? (s.rejected / total) * 100 : null;
  const okPct = rugPct === null ? null : 100 - rugPct;
  const text = okPct === null || rugPct === null ? null : splitPctText(okPct, rugPct);
  // The rollup only began counting recently: say so while it covers less than the window.
  const partialSince =
    s.oldestHour && new Date(s.oldestHour).getTime() > Date.now() - days * 86_400_000 + 3_600_000
      ? new Date(s.oldestHour)
      : null;

  return (
    <section className="lh-section lh-safety">
      <div className="lh-screened-head">
        <h3>Safety screen</h3>
        <button
          type="button"
          className="ghost share-btn"
          disabled={total === 0}
          onClick={() => setSharing(true)}
          title="Share this as an image"
        >
          <ShareIcon size={14} /> Share
        </button>
      </div>
      <p className="faint small">
        Every new token the scanner checked in the last {span}: the ones that cleared our safety screen, and
        the ones it turned away as Probable Rugs (mint or freeze authority kept, liquidity not locked, Mayhem
        Mode, a bundled launch, a top 10 that is farmed, sniped or too concentrated, a single holder over 10%,
        a top 25 that is mostly linked or mostly exchange-funded).
      </p>

      {okPct === null || rugPct === null || text === null ? (
        <p className="muted small">No tokens have been screened in this window yet.</p>
      ) : (
        <>
          <div className="lh-safety-figures">
            <div className="lh-safety-figure ok">
              <span className="lh-safety-value num">{text.ok}</span>
              <span className="muted small">
                Accepted · <span className="num">{s.accepted.toLocaleString()}</span> tokens
              </span>
            </div>
            <div className="lh-safety-figure rug">
              <span className="lh-safety-value num">{text.rug}</span>
              <span className="muted small">
                Probable Rugs · <span className="num">{s.rejected.toLocaleString()}</span> tokens
              </span>
            </div>
          </div>
          <div
            className="lh-safety-track"
            role="meter"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(rugPct)}
            aria-valuetext={`${text.rug} Probable Rugs, ${text.ok} accepted`}
            aria-label={`Probable Rugs: ${text.rug} of ${total.toLocaleString()} tokens screened; ${text.ok} accepted`}
          >
            <span className="lh-safety-ok" style={{ width: `${okPct}%` }} />
            <span className="lh-safety-rug" style={{ width: `${rugPct}%` }} />
            <span
              className="lh-safety-knob"
              // Kept inside the track at either end, like the share image's knob.
              style={{ left: `clamp(4px, ${okPct}%, calc(100% - 4px))` }}
              aria-hidden
            />
          </div>
          <div className="lh-safety-ticks faint small num" aria-hidden>
            <span>0%</span>
            <span>25%</span>
            <span>50%</span>
            <span>75%</span>
            <span>100%</span>
          </div>
          <p className="faint small lh-foot">
            {total.toLocaleString()} tokens screened, each counted once by the hour it was first scanned
            {partialSince
              ? `, since ${partialSince.toLocaleString([], { month: "short", day: "numeric", hour: "numeric" })} when this count began`
              : ""}
            . Accepted means it cleared the screen at least once.
            {s.summedAt ? ` Summed ${ago(s.summedAt)}.` : ""}
          </p>
        </>
      )}

      {sharing && (
        <ShareImageDialog
          title={`Safety screen, last ${span}`}
          fileName={`trenchscanner-likely-rugs-${days === 1 ? "24h" : `${days}d`}`}
          caption={`TrenchScanner: ${text?.rug ?? "–"} of new tokens are Probable Rugs, ${partialSince ? `since ${sinceUtc(partialSince)}` : `last ${span}`}`}
          link="trenchscanner.app"
          render={() =>
            renderSafetyCard({ accepted: s.accepted, rejected: s.rejected, span, since: partialSince })
          }
          onClose={() => setSharing(false)}
        />
      )}
    </section>
  );
}
