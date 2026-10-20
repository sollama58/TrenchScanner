import { setAppearance, useAppearance } from "../appearance";
import {
  CHART_EVENT_FIRST_OPTIONS,
  CHART_EVENT_KIND_OPTIONS,
  type ChartEventFirstKind,
  type ChartEventKind,
} from "../chartEvents";

/**
 * Customize › Chart events, beside Chart wallet trades: which flags the token chart draws, and
 * whether filter matches and model calls collapse to the earliest one. Saved with the feed's
 * appearance, so every chart on every device draws the same flags.
 */
export function ChartEventsPicker() {
  const look = useAppearance();
  const toggleKind = (kind: ChartEventKind) => {
    const has = look.chartEventKinds.includes(kind);
    setAppearance({
      chartEventKinds: CHART_EVENT_KIND_OPTIONS.map((k) => k.kind).filter((k) =>
        k === kind ? !has : look.chartEventKinds.includes(k),
      ),
    });
  };
  const toggleFirst = (kind: ChartEventFirstKind) => {
    const has = look.chartEventFirst.includes(kind);
    setAppearance({
      chartEventFirst: CHART_EVENT_FIRST_OPTIONS.map((k) => k.kind).filter((k) =>
        k === kind ? !has : look.chartEventFirst.includes(k),
      ),
    });
  };
  return (
    <div className="field-group">
      <h4>Chart events</h4>
      <div role="group" aria-label="Event markers on token charts">
        {CHART_EVENT_KIND_OPTIONS.map((k) => (
          <label key={k.kind} className="check">
            <input
              type="checkbox"
              checked={look.chartEventKinds.includes(k.kind)}
              onChange={() => toggleKind(k.kind)}
            />
            {k.label}
          </label>
        ))}
      </div>
      <div role="group" aria-label="Only the first of each">
        <span className="small">Only the first of each</span>
        {CHART_EVENT_FIRST_OPTIONS.map((k) => (
          <label key={k.kind} className="check">
            <input
              type="checkbox"
              checked={look.chartEventFirst.includes(k.kind)}
              onChange={() => toggleFirst(k.kind)}
            />
            {k.label}
          </label>
        ))}
      </div>
      <p className="faint small check-hint">
        Only the first filter and the first model. Later filters and later model calls stay off the chart;
        alerts all show unless Alert is checked here or the Alert kind is off. A kind that is off draws no
        line and no flag. Passed screen starts off.
      </p>
    </div>
  );
}
