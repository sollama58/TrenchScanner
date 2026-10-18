import { shortAddress } from "../format";
import { KolAvatar } from "./KolAvatar";
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
 * else its short address. A KOL with an X picture has it ahead of the name.
 */
export function WalletText({ wallet, names }: { wallet: string | null | undefined; names?: WalletNames }) {
  if (!wallet) return null;
  const n = names?.[wallet];
  if (!n) return <span className="num">{shortAddress(wallet)}</span>;
  const text = (
    <span
      className={`wallet-name src-${n.source}${isPumpfunName(n) ? " pumpfun-name" : ""}${isFomoName(n) ? " fomo-name" : ""}`}
      title={`${n.mine ? `Your label (${n.source === "kol" ? "KOL" : "User Tracked"})` : SOURCE_TEXT[n.source]}: ${n.name} · ${wallet}`}
    >
      {walletNameText(n)}
    </span>
  );
  if (!n.avatar) return text;
  // A KOL's X picture ahead of its name (user ask 2026-10-18); a picture that fails just goes.
  return (
    <span className="wallet-named">
      <KolAvatar src={n.avatar} className="wallet-pic" />
      {text}
    </span>
  );
}
