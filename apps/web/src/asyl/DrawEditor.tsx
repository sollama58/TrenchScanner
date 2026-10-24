import { useEffect, useRef } from "react";
import { DRAW_COLOURS, DRAWN_LABEL_MAX, DRAWN_TEXT_MAX, type DrawColour } from "./graph";

/**
 * The editor for a line or text box the reader drew (user ask 2026-10-24): its label or text, its
 * colour, and a way to delete it. It opens on the drawing just made or clicked, with the cursor in
 * the text. A spell of typing is one undo step.
 */
export function DrawEditor({
  kind,
  value,
  colour,
  onStartEdit,
  onChange,
  onColour,
  onDelete,
  onDone,
}: {
  kind: "line" | "text";
  value: string;
  colour: DrawColour;
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
    <div className="asyl-draw-editor" role="dialog" aria-label={kind === "line" ? "Line label" : "Text box"}>
      {kind === "line" ? (
        <input {...common} maxLength={DRAWN_LABEL_MAX} placeholder="Label this line (optional)" />
      ) : (
        <textarea {...common} rows={2} maxLength={DRAWN_TEXT_MAX} placeholder="Write here" />
      )}
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
      </div>
      <button className="asyl-icon-btn" title="Delete (Del)" aria-label="Delete" onClick={onDelete}>
        🗑
      </button>
      <button className="asyl-btn primary" onClick={onDone}>
        Done
      </button>
    </div>
  );
}
