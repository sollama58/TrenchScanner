import { useState } from "react";
import { parseDecimal } from "../decimal";
import { CloseIcon } from "./Icons";

/**
 * Settings > Trading's buy and sell buttons, drawn as the Trade panel draws them (user ask
 * 2026-10-18): the same green and red buttons on the same grid, one or two rows, each one edited
 * in place. A button's amount is typed straight into it ("0.5" or "0,5", decimal.ts) and saved on
 * leaving it; the × removes it, + adds one. A locked button (the 100% sale, which every list keeps)
 * shows but can't be changed.
 */
export function PresetButtonsEditor({
  side,
  values,
  unit,
  min,
  max,
  maxCount,
  minCount = 1,
  grid,
  hint,
  locked = () => false,
  suggest,
  onChange,
}: {
  side: "buy" | "sell";
  values: number[];
  /** Shown on each button, as the Trade panel does ("SOL" under a buy, "%" after a sale). */
  unit: "SOL" | "%";
  min: number;
  max: number;
  maxCount: number;
  minCount?: number;
  /** The Trade panel's own grid for these buttons (presetCols / sellCols). */
  grid: React.CSSProperties;
  hint: string;
  locked?: (v: number) => boolean;
  /** The amount a new button starts at. */
  suggest: (values: number[]) => number;
  onChange: (next: number[]) => void;
}) {
  // A new button's field takes the cursor.
  const [focusAt, setFocusAt] = useState<number | null>(null);
  const editable = values.filter((v) => !locked(v)).length;
  const canRemove = editable > minCount;
  const title = side === "buy" ? "Buy" : "Sell";

  const add = () => {
    const v = suggest(values);
    // New sales go before the locked 100%, so "all" stays last as in the panel.
    const at = values.findIndex(locked);
    const next = at < 0 ? [...values, v] : [...values.slice(0, at), v, ...values.slice(at)];
    setFocusAt(at < 0 ? next.length - 1 : at);
    onChange(next);
  };

  return (
    <div className={`tm-side ${side} preset-editor`} role="group" aria-label={`${title} buttons`}>
      <div className="tm-side-head">
        <span className="tm-side-title">{title}</span>
        <span className="muted small">{hint}</span>
      </div>
      <div className="tm-presets" style={grid}>
        {values.map((v, i) =>
          locked(v) ? (
            <span
              key={`${i}-${v}`}
              className="tm-preset preset-edit locked"
              title="Always there, to close a position"
            >
              <span className="num">{v}%</span>
              <small>all</small>
            </span>
          ) : (
            <PresetField
              key={`${i}-${v}`}
              value={v}
              unit={unit}
              label={`${title} button ${i + 1}, ${unit === "SOL" ? "SOL" : "% of the position"}`}
              autoFocus={focusAt === i}
              valid={(n) => n >= min && n <= max}
              onSave={(n) => onChange(values.map((x, j) => (j === i ? n : x)))}
              onRemove={canRemove ? () => onChange(values.filter((_, j) => j !== i)) : undefined}
            />
          ),
        )}
      </div>
      <div className="preset-editor-foot small">
        {values.length < maxCount ? (
          <button type="button" className="ghost small" onClick={add}>
            + Add a button
          </button>
        ) : (
          <span className="faint">
            {maxCount} buttons, the most {side === "buy" ? "these rows hold" : "there can be"}
          </span>
        )}
        <span className="faint">
          {min}
          {unit === "%" ? "%" : ""} to {max}
          {unit === "%" ? "%" : ` ${unit}`} each
        </span>
      </div>
    </div>
  );
}

function PresetField({
  value,
  unit,
  label,
  autoFocus,
  valid,
  onSave,
  onRemove,
}: {
  value: number;
  unit: "SOL" | "%";
  label: string;
  autoFocus: boolean;
  valid: (n: number) => boolean;
  onSave: (n: number) => void;
  onRemove?: () => void;
}) {
  const [text, setText] = useState(String(value));
  const n = parseDecimal(text);
  const bad = text.trim() !== "" && (n === null || !valid(n));
  const commit = () => {
    if (text.trim() === "" && onRemove) return onRemove();
    if (n === null || !valid(n)) return setText(String(value));
    if (n !== value) onSave(n);
    else setText(String(value));
  };
  return (
    <span className={`tm-preset preset-edit${bad ? " bad" : ""}`}>
      <input
        className="num"
        inputMode="decimal"
        autoComplete="off"
        aria-label={label}
        aria-invalid={bad || undefined}
        autoFocus={autoFocus}
        value={text}
        style={{ "--len": Math.max(text.length, 1) } as React.CSSProperties}
        onChange={(e) => setText(e.target.value)}
        onFocus={(e) => e.target.select()}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            const el = e.currentTarget;
            setText(String(value));
            requestAnimationFrame(() => el.blur());
          }
        }}
      />
      <small>{unit}</small>
      {onRemove && (
        <button
          type="button"
          className="preset-x"
          aria-label={`Remove ${label}`}
          title="Remove this button"
          // Not on blur: the field's own blur would save first and the click land on a new list.
          onMouseDown={(e) => e.preventDefault()}
          onClick={onRemove}
        >
          <CloseIcon size={10} />
        </button>
      )}
    </span>
  );
}
