import { shortAddress } from "../format";
import { isFomoName, isPumpfunName, walletNameText, type WalletNames } from "../walletNames";

const SOURCE_TEXT = {
  kol: "KOL",
  "kol-side": "KOL Known Side",
  identity: "Helius",
  pumpfun: "Pump.fun",
  fomo: "FOMO",
  exchange: "Exchange",
  tracked: "User Tracked",
} as const;

/**
 * A wallet in a list: its name (a KOL, an exchange, a named service, a Pump.fun username in quotes
 * and light green, a FOMO one in quotes and purple) when it has one, with the address on hover,
 * else its short address.
 */
export function WalletText({ wallet, names }: { wallet: string | null | undefined; names?: WalletNames }) {
  if (!wallet) return null;
  const n = names?.[wallet];
  if (!n) return <span className="num">{shortAddress(wallet)}</span>;
  return (
    <span
      className={`wallet-name src-${n.source}${isPumpfunName(n) ? " pumpfun-name" : ""}${isFomoName(n) ? " fomo-name" : ""}`}
      title={`${n.mine ? `Your label (${n.source === "kol" ? "KOL" : "User Tracked"})` : SOURCE_TEXT[n.source]}: ${n.name} · ${wallet}`}
    >
      {walletNameText(n)}
    </span>
  );
}
