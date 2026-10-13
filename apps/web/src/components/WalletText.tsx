import { shortAddress } from "../format";
import type { WalletNames } from "../walletNames";

const SOURCE_TEXT = { kol: "KOL", identity: "Helius", exchange: "Exchange" } as const;

/**
 * A wallet in a list: its name (a KOL, an exchange, a named service) when it has one, with the
 * address on hover, else its short address.
 */
export function WalletText({ wallet, names }: { wallet: string | null | undefined; names?: WalletNames }) {
  if (!wallet) return null;
  const n = names?.[wallet];
  if (!n) return <span className="num">{shortAddress(wallet)}</span>;
  return (
    <span className={`wallet-name src-${n.source}`} title={`${SOURCE_TEXT[n.source]}: ${n.name} · ${wallet}`}>
      {n.name}
    </span>
  );
}
