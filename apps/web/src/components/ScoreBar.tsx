import type { ScoreBand } from "../api";

/** The tone each score band's badge takes. */
export const BAND_TONE: Record<ScoreBand["id"], string> = {
  "on-target": "good",
  "closing-in": "info",
  "getting-there": "neutral",
  "far-off": "neutral",
};

/** A 0-100 score as a bar, the number and its band - the model and filter leaderboards share it. */
export function ScoreBar({
  score,
  band,
  title,
}: {
  score: number | null;
  band: ScoreBand | null;
  title: string;
}) {
  if (score === null) return <span className="faint">–</span>;
  return (
    <div className="score-bar" title={title}>
      <span className="score-track">
        <span className="score-fill" style={{ width: `${Math.max(2, Math.min(100, score))}%` }} />
      </span>
      <span className="num">{score.toFixed(0)}</span>
      {band && <span className={`badge score-band ${BAND_TONE[band.id]}`}>{band.label}</span>}
    </div>
  );
}
