/**
 * The subscription's price, in the one unit the code is allowed to compare.
 *
 * $ASDFASDFA has 6 decimals (verified on-chain against the mint account), so 55,200 tokens is
 * 55,200,000,000 base units. Everything downstream compares base units as BigInt and never
 * touches a float: a burn amount is a u64, and the moment it goes through a double the top of
 * that range stops being exact. Nothing about "did this person pay" should depend on rounding.
 */
export const SUBSCRIPTION_MINT = "9zB5wRarXMj86MymwLumSKA1Dx35zPqqKfcZtK1Spump";

export const SUBSCRIPTION_MINT_DECIMALS = 6;

/** Tokens per month, in whole tokens - the figure shown to people. */
export const SUBSCRIPTION_TOKENS_PER_MONTH = 55_200;

/** The same figure in base units, which is what the chain reports and what we compare. */
export const SUBSCRIPTION_RAW_PER_MONTH =
  BigInt(SUBSCRIPTION_TOKENS_PER_MONTH) * 10n ** BigInt(SUBSCRIPTION_MINT_DECIMALS);

/** Days of access one month buys. */
export const SUBSCRIPTION_DAYS = 30;

/**
 * Most months a single burn can buy.
 *
 * Burning a multiple of the price buys the multiple, so nobody who fat-fingers a 2x burn has to
 * open a support ticket. Capped so that a burn of someone's entire bag doesn't mint a subscription
 * lasting past the heat death of the sun - and so an overflow in the arithmetic below can't turn
 * into an absurd expiry date.
 */
export const MAX_MONTHS_PER_BURN = 12;

/** The SPL Token program, whose `burn` / `burnChecked` instructions are the only ones that count. */
export const SPL_TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
