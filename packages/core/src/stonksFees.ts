import { normalizeLaunchpad, STONKS_LAUNCHPAD } from "./launchpads.js";

/**
 * Stonks' fee wallet (user ask 2026-10-16, labeled "Stonk_Fees"). Every Stonks coin is a
 * Token-2022 mint with a 3% transfer fee whose withheld-fee authority is this wallet: the fees each
 * trade leaves in its holders' token accounts are swept into it, so on a Stonks coin it holds a
 * share of supply that nobody bought (seen 2026-10-16 on BYTE, SHORT, RIM and BOO: the
 * transferFeeConfig's withdrawWithheldAuthority, read on chain and in RugCheck's token_extensions).
 *
 * It is never a holder, on any coin (owner decision 2026-10-17; it was Stonks coins only before): it
 * is left out of every holder figure (top 10, largest holder, the top-holder lists behind linked
 * wallets, bundles, KOL Bundled and the bubble map), as a venue account is, and out of the trade
 * tape and wallet risk (PLATFORM_WALLETS). The token modal shows its share on a Stonks coin on its
 * own card (GET /tokens/:mint/stonk-fees).
 */
export const STONKS_FEE_WALLET = "5KXDF6QnqhBj72hDtJNkkpFaQVUfbFXNybMsp3DiK6tD";
export const STONKS_FEE_WALLET_LABEL = "Stonk_Fees";

/**
 * Launchpad wallets that are not people, with the name they are shown under. Never a funder that
 * links wallets, a side wallet or a transfer link (like the exchange hot wallets), on any coin.
 */
export const PLATFORM_WALLETS: ReadonlyMap<string, string> = new Map([
  [STONKS_FEE_WALLET, STONKS_FEE_WALLET_LABEL],
]);

/** The wallets every coin's holder figures leave out beyond its venues: Stonks' fee wallet, on every coin. */
export const FEE_HOLDERS: ReadonlySet<string> = new Set([STONKS_FEE_WALLET]);

/** What tells a Stonks coin: its recorded launchpad, or its mint's withheld-fee authority. */
export interface StonksCoinHint {
  launchpad?: string | null;
  /** The mint's transferFeeConfig.withdrawWithheldAuthority, when read. */
  withheldFeeAuthority?: string | null;
}

/** Whether a coin is a Stonks launch: its launchpad says so, or Stonks' fee wallet takes its fees. */
export function isStonksCoin(hint: StonksCoinHint): boolean {
  return (
    normalizeLaunchpad(hint.launchpad) === STONKS_LAUNCHPAD || hint.withheldFeeAuthority === STONKS_FEE_WALLET
  );
}

/**
 * The withheld-fee authority of a Token-2022 mint's transfer fee, from either reading of its
 * extensions: the RPC's jsonParsed list (`[{ extension: "transferFeeConfig", state: {...} }]`) or
 * RugCheck's token_extensions object (`{ transferFeeConfig: {...} }`). Undefined without one.
 */
export function withheldFeeAuthorityOf(extensions: unknown): string | undefined {
  let config: unknown;
  if (Array.isArray(extensions)) {
    const entry = extensions.find(
      (e: unknown) => (e as { extension?: unknown } | null)?.extension === "transferFeeConfig",
    ) as { state?: unknown } | undefined;
    config = entry?.state;
  } else if (extensions && typeof extensions === "object") {
    config = (extensions as { transferFeeConfig?: unknown }).transferFeeConfig;
  }
  const authority = (config as { withdrawWithheldAuthority?: unknown } | null | undefined)
    ?.withdrawWithheldAuthority;
  return typeof authority === "string" ? authority : undefined;
}
