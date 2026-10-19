/**
 * One hit rate against its target, as a ring: the arc is the measured rate, the notch is the
 * target. The verdict is spelled out under it in words, never left to color alone.
 */
export function RingGauge({
  label,
  value,
  target,
  graded,
  minGraded,
  series = 1,
}: {
  label: string;
  value: number | null;
  target: number;
  graded: number;
  minGraded: number;
  series?: 1 | 2;
}) {
  const enough = graded >= minGraded;
  const met = value !== null && value >= target;
  const state = !enough ? "early" : met ? "met" : "below";
  const r = 38;
  const c = 2 * Math.PI * r;
  const frac = Math.min(1, Math.max(0, (value ?? 0) / 100));
  // The notch sits on the ring at the target's angle, measured clockwise from 12 o'clock.
  const a = (target / 100) * 2 * Math.PI - Math.PI / 2;
  const notch = (rr: number) => [50 + rr * Math.cos(a), 50 + rr * Math.sin(a)] as const;
  const [x1, y1] = notch(r - 9);
  const [x2, y2] = notch(r + 9);
  return (
    <div className="ring">
      <svg
        viewBox="0 0 100 100"
        className="ring-svg"
        role="img"
        aria-label={`${label}: ${value === null ? "no data" : `${value.toFixed(0)}%`}, target ${target}%`}
      >
        <circle cx="50" cy="50" r={r} className="ring-track" />
        <circle
          cx="50"
          cy="50"
          r={r}
          className={`ring-arc s${series}`}
          strokeDasharray={`${c * frac} ${c}`}
          transform="rotate(-90 50 50)"
        />
        <line x1={x1} y1={y1} x2={x2} y2={y2} className="ring-notch" />
        <text x="50" y="49" className="ring-value" textAnchor="middle">
          {value === null ? "–" : `${value.toFixed(0)}%`}
        </text>
        <text x="50" y="63" className="ring-sub" textAnchor="middle">
          target {target}%
        </text>
      </svg>
      <div className="ring-text">
        <span className="ring-label">{label}</span>
        <span className={`state ${state}`}>
          {state === "early"
            ? `Early · ${graded}/${minGraded} graded`
            : met
              ? "✓ On target"
              : "▼ Below target"}
        </span>
      </div>
    </div>
  );
}
