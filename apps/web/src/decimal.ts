/**
 * Typed decimals (user ask 2026-10-18): some locales write half a SOL "0.5", others "0,5", and a
 * phone's decimal keypad gives whichever the phone's language uses. Every amount field in trading
 * takes either, as the one decimal separator, and hands the rest of the app a plain number (or,
 * for the API, a dot-decimal string). Grouping ("1,000.5", "1.000,5") is refused rather than
 * guessed at: "1,000" is a thousand in one locale and one in another, and this is money.
 */

const DECIMAL_RE = /^(\d*)(?:[.,](\d*))?$/;

/** A typed decimal in dot form ("0,5" -> "0.5", ",5" -> "0.5", "2," -> "2"), or null when it isn't one. */
export function decimalText(text: string): string | null {
  const m = DECIMAL_RE.exec(text.trim());
  if (!m) return null;
  const whole = m[1] ?? "";
  const frac = m[2] ?? "";
  if (!whole && !frac) return null;
  return frac ? `${whole || "0"}.${frac}` : whole;
}

/** A typed decimal as a number, either separator; null when it isn't one. */
export function parseDecimal(text: string): number | null {
  const t = decimalText(text);
  if (t === null) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * A list of typed amounts, "0.1, 0.25 0.5" or "0,1; 0,25 0,5": split on spaces and semicolons,
 * and on commas where a comma can't be a decimal (after a dot-decimal, or more than one in a row
 * of digits, "0.1,0.5" or "1,2,3"). "1,5" alone is one and a half. Anything that isn't a number
 * is dropped.
 */
export function parseDecimalList(text: string): number[] {
  const out: number[] = [];
  for (const chunk of text.split(/[\s;]+/)) {
    if (!chunk) continue;
    const commas = chunk.split(",").length - 1;
    const parts = chunk.includes(".") || commas > 1 ? chunk.split(",") : [chunk];
    for (const p of parts) {
      const n = parseDecimal(p);
      if (n !== null && p !== "") out.push(n);
    }
  }
  return out;
}

/**
 * A typed amount in base units (lamports at 9 decimals), exactly: no float on the way. Null when it
 * isn't a number, has more than `decimals` places or `maxWhole` whole digits.
 */
export function decimalUnits(text: string, decimals: number, maxWhole = 15): bigint | null {
  const t = decimalText(text);
  if (t === null) return null;
  const [whole = "", frac = ""] = t.split(".");
  if (whole.length > maxWhole || frac.length > decimals) return null;
  return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
}

/** "0.1, 0.25 0.5" -> [0.1, 0.25, 0.5]: amounts from `min` (above 0) up to `max`, at most `count` of them. */
export function parseAmounts(text: string, max: number, count: number, min = 0): number[] {
  return parseDecimalList(text)
    .filter((n) => n > 0 && n >= min && n <= max)
    .slice(0, count);
}
