import { useEffect, useState, type InputHTMLAttributes } from "react";
import { parseDecimal } from "../decimal";

/**
 * A number field that takes "0.5" and "0,5" alike (decimal.ts). A text field with the decimal
 * keypad, not type="number": browsers in a comma locale empty a number field's value when "," is
 * typed (or a "." in theirs), so the app read a blank, or a 0. Holds the typed text while it's
 * being typed, reports each whole number as it's typed, and shows the saved value again on leaving
 * a field that doesn't hold one. An empty field reads as `empty` (0 unless given).
 */
export function DecimalInput({
  value,
  onValue,
  empty = 0,
  onBlur,
  ...rest
}: {
  value: number;
  onValue: (n: number) => void;
  /** What a cleared field means. */
  empty?: number;
} & Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type" | "inputMode">) {
  const [text, setText] = useState(() => String(value));
  // Follow the value from outside (a reset, the server's copy) unless the text already says it.
  useEffect(() => {
    setText((t) => (read(t, empty) === value ? t : String(value)));
  }, [value, empty]);
  return (
    <input
      {...rest}
      type="text"
      inputMode="decimal"
      autoComplete="off"
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        const n = read(e.target.value, empty);
        if (n !== null) onValue(n);
      }}
      onBlur={(e) => {
        if (read(text, empty) === null) setText(String(value));
        onBlur?.(e);
      }}
    />
  );
}

function read(text: string, empty: number): number | null {
  return text.trim() === "" ? empty : parseDecimal(text);
}
