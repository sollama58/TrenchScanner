import { useEffect, useRef } from "react";
import type { FeedStats } from "../api";
import { RingGauge } from "./Charts";
import { FeedReturns } from "./FeedReturns";
import { BoltIcon, CloseIcon, RadarIcon, TrophyIcon } from "./Icons";
import { multiple, pct } from "../format";

/** Graded alerts below which a hit rate shows as "early" rather than as a verdict. */
const MIN_GRADED = 10;

/**
 * The Live tab's feed numbers (what the five tiles over the feed used to show), in a native modal
 * dialog: a centered panel on desktop, a sheet from the bottom on phones.
 */
export function FeedStatsModal({
  open,
  onClose,
  stats: fs,
  hours,
  targets: t,
  weather,
  pollKey,
}: {
  open: boolean;
  onClose: () => void;
  stats: FeedStats | null;
  hours: number;
  targets: { hitRate2xPct: number; hitRate4xPct: number };
  weather: React.ReactNode;
  /** Changes when the feed's makeup does (the models it follows), so the returns refetch. */
  pollKey: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="about-modal sheet-modal stats-modal"
      aria-labelledby="feed-stats-title"
      onClose={onClose}
      // A click on the backdrop lands on the dialog element itself; clicks inside land on its content.
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="about-body">
        <header className="about-head">
          <h2 id="feed-stats-title">Your feed · last {hours}h</h2>
          <button className="ghost icon-btn" onClick={onClose} aria-label="Close">
            <CloseIcon size={16} />
          </button>
        </header>
        {open && (
          <>
            <section className="kpis stats-grid">
              <div className="panel kpi stats-wide">
                <span className="eyebrow">
                  <RadarIcon size={13} /> Alerts · {hours}h
                </span>
                <span className="kpi-value num">{fs?.alerts ?? "–"}</span>
                <small className="muted">
                  {fs
                    ? fs.alerts === 0
                      ? "No alerts yet"
                      : `${fs.fromFilter} from your filter${fs.showModelAlerts ? `, ${fs.fromModels} model calls` : ""}`
                    : "Loading…"}
                </small>
                {fs && fs.pending > 0 && <small className="faint">{fs.pending} still grading</small>}
              </div>
              <div className="panel kpi kpi-ring">
                <RingGauge
                  label="Hit 2x within 15 min"
                  value={fs?.hit2xPct ?? null}
                  target={t.hitRate2xPct}
                  graded={fs?.graded ?? 0}
                  minGraded={MIN_GRADED}
                  series={1}
                />
              </div>
              <div className="panel kpi kpi-ring">
                <RingGauge
                  label="Hit 4x within 30 min"
                  value={fs?.hit4xPct ?? null}
                  target={t.hitRate4xPct}
                  graded={fs?.goalGraded ?? 0}
                  minGraded={MIN_GRADED}
                  series={2}
                />
              </div>
              <div className="panel kpi">
                <span className="eyebrow">
                  <TrophyIcon size={13} /> Hit 10x within 1 hr
                </span>
                <span className="kpi-value num">{fs?.hit10xPct != null ? pct(fs.hit10xPct, 1) : "–"}</span>
                <small className="muted">
                  {fs?.tenXGraded
                    ? `${fs.hit10x ?? 0} of ${fs.tenXGraded} settled alerts`
                    : "No settled alerts yet"}
                </small>
              </div>
              <div className="panel kpi">
                <span className="eyebrow">
                  <BoltIcon size={13} /> Best run · {hours}h
                </span>
                <span className="kpi-value num">{fs?.best ? multiple(fs.best.peakPct) : "–"}</span>
                <small className="muted">
                  {fs?.best ? (fs.best.symbol ? `$${fs.best.symbol}` : "unnamed token") : " "}
                </small>
                {fs?.medianPeakPct != null && (
                  <small className="faint">Typical alert peaked at {multiple(fs.medianPeakPct)}</small>
                )}
              </div>
            </section>
            <p className="faint small stats-note">
              Coins alerted in your feed over the last {hours} hours, graded from the alert price. Alerts
              still being graded don&apos;t count as misses.
            </p>
            <FeedReturns pollKey={pollKey} />
            {weather}
          </>
        )}
      </div>
    </dialog>
  );
}
