/**
 * A safety-screen reason without its measured figures, for grouping: "82% of top-10 holders...",
 * "16 of the 20 top holders are linked", "own 45% of supply", "filled 2s after launch". The cutoff
 * in the trailing parentheses, and "top-10"-style names, are kept.
 */
export function screenReasonLabel(reason: string): string {
  const cut = reason.lastIndexOf(" (");
  const head = cut > 0 ? reason.slice(0, cut) : reason;
  return head.replace(/(?<![-\w.])\d+(\.\d+)?/g, "N") + (cut > 0 ? reason.slice(cut) : "");
}
