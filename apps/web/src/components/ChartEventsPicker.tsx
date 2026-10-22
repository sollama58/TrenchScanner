import { setAppearance, useAppearance } from "../appearance";
import {
  CHART_EVENT_FIRST_OPTIONS,
  CHART_EVENT_KIND_OPTIONS,
  type ChartEventEmphasis,
  type ChartEventFirstKind,
  type ChartEventKind,
  type ChartEventScale,
} from "../chartEvents";

const KIND_TITLE: Record<ChartEventKind, string> = {
  alert: "An alert that is not a filter match or a model call",
  screen: "When the coin first passed the safety screen",
  filter: "The mark labeled Alert, where a filter caught the coin",
  model: "Model alert, and each model's own call",
  graduation: "When a graduated coin is marked",
  scanned: "A coin opened from search, before it was alerted",
};

const EMPHASIS: { id: ChartEventEmphasis; label: string; title: string }[] = [
  { id: "off", label: "Off", title: "Every flag in the same colour" },
  { id: "brand", label: "Brand", title: "The earliest flag in the chart's brand colour" },
  { id: "win", label: "Win", title: "The earliest flag in the win colour" },
  { id: "loss", label: "Loss", title: "The earliest flag in the loss colour" },
  { id: "mine", label: "Yours", title: "The earliest flag in your filter's colour" },
];

const SIZES: { id: ChartEventScale; label: string; title: string }[] = [
  { id: "s", label: "Small", title: "Smaller flags and lines" },
  { id: "m", label: "Medium", title: "Medium, the size the chart already draws" },
  { id: "l", label: "Large", title: "Larger flags and lines" },
];

/**
 * Customize › Chart events, beside Chart wallet trades: which flags the token chart draws, and
 * how. The vertical line and the horizontal price line follow the same switches. Saved with the
 * feed's appearance, so every chart on every device draws the same flags.
 */
export function ChartEventsPicker() {
  const look = useAppearance();
  const on = look.chartEvents;
  const toggleKind = (kind: ChartEventKind) => {
    const has = look.chartEventKinds.includes(kind);
    setAppearance({
      chartEvents: true,
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
      <label className="check">
        <input
          type="checkbox"
          checked={on}
          onChange={() => setAppearance({ chartEvents: !on })}
        />
        Show event flags on token charts
      </label>
      <div role="group" aria-label="Event markers on token charts">
        {CHART_EVENT_KIND_OPTIONS.map((k) => (
          <label key={k.kind} className="check" title={KIND_TITLE[k.kind]}>
            <input
              type="checkbox"
              checked={look.chartEventKinds.includes(k.kind)}
              disabled={!on}
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
              disabled={!on}
              onChange={() => toggleFirst(k.kind)}
            />
            {k.label}
          </label>
        ))}
      </div>
      <label className="check">
        <input
          type="checkbox"
          checked={look.chartEventLabels}
          disabled={!on}
          onChange={() => setAppearance({ chartEventLabels: !look.chartEventLabels })}
        />
        Labels on the flags
      </label>
      <div className={`cm-scale${on ? "" : " off"}`}>
        <span>Flag size</span>
        <div className="segmented small" role="radiogroup" aria-label="Event flag size">
          {SIZES.map((s) => (
            <button
              key={s.id}
              type="button"
              role="radio"
              aria-checked={look.chartEventScale === s.id}
              className={look.chartEventScale === s.id ? "on" : ""}
              title={s.title}
              disabled={!on}
              onClick={() => setAppearance({ chartEventScale: s.id })}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>
      <div className={`cm-scale${on ? "" : " off"}`}>
        <span>Earliest flag</span>
        <div className="segmented small wrap" role="radiogroup" aria-label="Earliest flag colour">
          {EMPHASIS.map((s) => (
            <button
              key={s.id}
              type="button"
              role="radio"
              aria-checked={look.chartEventEmphasis === s.id}
              className={look.chartEventEmphasis === s.id ? "on" : ""}
              title={s.title}
              disabled={!on}
              onClick={() => setAppearance({ chartEventEmphasis: s.id })}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>
      <p className="faint small check-hint">
        Each kind draws a vertical line and a horizontal price line. Turning a kind off removes both;
        turning it on brings both back. The switch above hides every event flag and keeps the kinds.
        Only the first filter and the first model. Later filters and later model calls stay off the
        chart; alerts all show unless Alert is checked here or the Alert kind is off. Labels cover the
        flag and the price line&apos;s name. Passed screen starts off. The line stays coloured from a
        hidden screen pass, with no flag and no price line for it.
      </p>
    </div>
  );
}
