/**
 * Solana addresses, without a dependency. The panel builds site links only from a valid one, so a
 * bad answer from the API can never become a link anywhere else.
 *
 * A candidate is accepted only if it is base58 and decodes to exactly 32 bytes, so a shortened
 * label ("GPs…pump"), a ticker or a transaction signature never passes for a mint.
 */
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const INDEX = new Map([...ALPHABET].map((c, i) => [c, i]));

/** The decoded byte length of a base58 string, or -1 when it isn't base58. */
export function base58Length(value: string): number {
  const bytes: number[] = [];
  for (const char of value) {
    const digit = INDEX.get(char);
    if (digit === undefined) return -1;
    let carry = digit;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i]! * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  let leadingZeros = 0;
  while (leadingZeros < value.length && value[leadingZeros] === "1") leadingZeros++;
  return bytes.length + leadingZeros;
}

export function isMintAddress(value: string): boolean {
  return value.length >= 32 && value.length <= 44 && base58Length(value) === 32;
}

const CANDIDATE = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;

/** Every valid address inside a string (a URL, an attribute), in order, without repeats. */
export function mintsIn(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(CANDIDATE)) {
    const value = match[0];
    if (isMintAddress(value) && !out.includes(value)) out.push(value);
  }
  return out;
}
