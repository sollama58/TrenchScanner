import { useEffect, useRef } from "react";
import { DRAW_COLOURS, DRAWN_LABEL_MAX, DRAWN_TEXT_MAX, PEN_WIDTHS, type DrawColour } from "./graph";

/** The swatches, and any other colour from the browser's picker (user ask 2026-10-25). */
export function ColourPicker({
  colour,
  onColour,
}: {
  colour: DrawColour;
  onColour: (c: DrawColour) => void;
}) {
  const own = !(DRAW_COLOURS as readonly string[]).includes(colour);
  return (
    <div className="asyl-swatches" role="group" aria-label="Colour">
      {DRAW_COLOURS.map((c) => (
        <button
          key={c}
          type="button"
          className={c === colour ? "on" : ""}
          style={{ background: c }}
          aria-label={`Colour ${c}`}
          aria-pressed={c === colour}
          onClick={() => onColour(c)}
        />
      ))}
      <label
        className={`asyl-colour-pick${own ? " on" : ""}`}
        title="Any colour"
        style={own ? { background: colour } : undefined}
      >
        <input
          type="color"
          value={colour}
          aria-label="Any colour"
          onChange={(e) => onColour(e.target.value.toLowerCase())}
        />
      </label>
    </div>
  );
}

/** The pen's thicknesses, each shown as a dot of its size. */
export function WidthPicker({
  width,
  colour,
  onWidth,
}: {
  width: number;
  colour: DrawColour;
  onWidth: (w: number) => void;
}) {
  // The nearest of the four, for a stroke drawn at another zoom.
  const near = PEN_WIDTHS.reduce((a, b) => (Math.abs(b - width) < Math.abs(a - width) ? b : a));
  return (
    <div className="asyl-widths" role="group" aria-label="Thickness">
      {PEN_WIDTHS.map((w) => (
        <button
          key={w}
          type="button"
          className={w === near ? "on" : ""}
          aria-label={`Thickness ${w}`}
          aria-pressed={w === near}
          title={`Thickness ${w}`}
          onClick={() => onWidth(w)}
        >
          <span style={{ width: w + 2, height: w + 2, background: colour }} />
        </button>
      ))}
    </div>
  );
}

/** The pen tool's bar: its colour and thickness, while it is in hand. */
export function PenBar({
  colour,
  width,
  onColour,
  onWidth,
  onDone,
}: {
  colour: DrawColour;
  width: number;
  onColour: (c: DrawColour) => void;
  onWidth: (w: number) => void;
  onDone: () => void;
}) {
  return (
    <div className="asyl-draw-editor asyl-pen-bar" role="toolbar" aria-label="Pen">
      <span className="asyl-pen-hint">Draw on the map</span>
      <ColourPicker colour={colour} onColour={onColour} />
      <WidthPicker width={width} colour={colour} onWidth={onWidth} />
      <button className="asyl-btn primary" onClick={onDone} title="Stop drawing (Esc)">
        Done
      </button>
    </div>
  );
}

/**
 * The editor for a line, text box or pen stroke the reader drew (user ask 2026-10-24): its label or text, its
 * colour, and a way to delete it. It opens on the drawing just made or clicked, with the cursor in
 * the text. A spell of typing is one undo step.
 */
export function DrawEditor({
  kind,
  value,
  colour,
  width = 4,
  onStartEdit,
  onChange,
  onColour,
  onWidth,
  onDelete,
  onDone,
}: {
  kind: "line" | "text" | "stroke";
  value: string;
  colour: DrawColour;
  /** A pen stroke's thickness, in screen pixels at the zoom now. */
  width?: number;
  onWidth?: (w: number) => void;
  /** Typing is about to start: the page keeps the drawing as it was, for undo. */
  onStartEdit: () => void;
  onChange: (v: string) => void;
  onColour: (c: DrawColour) => void;
  onDelete: () => void;
  onDone: () => void;
}) {
  const box = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const editing = useRef(false);
  // After the click that opened it has done its own focusing, or that click would take focus back.
  useEffect(() => {
    const t = setTimeout(() => box.current?.focus(), 0);
    return () => clearTimeout(t);
  }, []);
  const common = {
    ref: box,
    className: "asyl-input",
    value,
    onFocus: () => {
      editing.current = false;
    },
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      // One undo step per spell of typing, not per key.
      if (!editing.current) {
        editing.current = true;
        onStartEdit();
      }
      onChange(e.target.value);
    },
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "Escape" || (e.key === "Enter" && (kind === "line" || e.metaKey || e.ctrlKey))) {
        e.preventDefault();
        onDone();
      }
    },
  };
  return (
    <div
      className="asyl-draw-editor"
      role="dialog"
      aria-label={kind === "line" ? "Line label" : kind === "text" ? "Text box" : "Pen stroke"}
    >
      {kind === "line" ? (
        <input {...common} maxLength={DRAWN_LABEL_MAX} placeholder="Label this line (optional)" />
      ) : kind === "text" ? (
        <textarea {...common} rows={2} maxLength={DRAWN_TEXT_MAX} placeholder="Write here" />
      ) : (
        <span className="asyl-pen-hint">Pen stroke</span>
      )}
      <ColourPicker colour={colour} onColour={onColour} />
      {kind === "stroke" && onWidth && <WidthPicker width={width} colour={colour} onWidth={onWidth} />}
      <button className="asyl-icon-btn" title="Delete (Del)" aria-label="Delete" onClick={onDelete}>
        🗑
      </button>
      <button className="asyl-btn primary" onClick={onDone}>
        Done
      </button>
    </div>
  );
}
