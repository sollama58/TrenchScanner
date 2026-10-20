/**
 * Pure checks the trade panel and the build share: which token account a sale may debit, how a
 * transfer fee caps Sell all, and whether a buy's SOL covers the buy, the fee, the preview rent
 * and the rent-exempt reserve. No RPC and no wallet.
 */

/** What of `raw` a transfer-fee mint can deliver to the pool. The fee is withheld from the transfer. */
export function sellableAfterTransferFee(raw: bigint, transferFeeBps: number): bigint {
  if (!Number.isInteger(transferFeeBps) || transferFeeBps <= 0) return raw;
  if (transferFeeBps >= 10_000) return 0n;
  const fee = (raw * BigInt(transferFeeBps) + 9_999n) / 10_000n;
  return raw > fee ? raw - fee : 0n;
}

/** The associated account the route debits, and whatever sits in other token accounts. */
export function splitTokenBalance(
  accounts: { address: string; raw: bigint }[],
  ata: string,
): { ata: bigint; elsewhere: bigint } {
  let ataRaw = 0n;
  let elsewhere = 0n;
  for (const account of accounts) {
    if (account.address === ata) ataRaw += account.raw;
    else elsewhere += account.raw;
  }
  return { ata: ataRaw, elsewhere };
}

export type SolShortPiece = "buy" | "fee" | "rent" | "reserve";

/** Which piece a buy is short of, or null when the balance covers the buy, fee, rent and reserve. */
export function solShortfall(input: {
  balance: bigint;
  buy: bigint;
  fee: bigint;
  rent: bigint;
  reserve: bigint;
}): { piece: SolShortPiece; have: bigint; need: bigint } | null {
  const need = input.buy + input.fee + input.rent + input.reserve;
  if (input.balance >= need) return null;
  const piece: SolShortPiece =
    input.balance < input.buy
      ? "buy"
      : input.balance < input.buy + input.fee
        ? "fee"
        : input.balance < input.buy + input.fee + input.rent
          ? "rent"
          : "reserve";
  return { piece, have: input.balance, need };
}

const PIECE_TEXT: Record<SolShortPiece, string> = {
  buy: "the buy",
  fee: "the network fee",
  rent: "the token-account rent",
  reserve: "the rent-exempt reserve that has to stay in the wallet",
};

/** Lamports as SOL, up to four decimals, for a refusal. */
export function solShortText(lamports: bigint): string {
  return (Number(lamports) / 1e9).toLocaleString("en-US", { maximumFractionDigits: 4 });
}

export function solShortfallText(short: { piece: SolShortPiece; have: bigint; need: bigint }): string {
  return (
    `Your wallet has ${solShortText(short.have)} SOL, short for ${PIECE_TEXT[short.piece]}. ` +
    `This buy needs ${solShortText(short.need)} SOL for the buy, the network fee, the token-account rent, and the rent-exempt reserve.`
  );
}
