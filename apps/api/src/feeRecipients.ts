import type { PumpCharityShare } from "@trenchscanner/core";

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** One fee recipient as a card shows it. `label` is a name or a shortened address, never blank. */
export interface CardFeeRecipient {
  label: string;
  /** Basis points of the creator fee. Null when the read did not give a share. */
  bps: number | null;
  /** Present and true on a charity's share, so a card can name the charities apart from wallets. */
  charity?: boolean;
  /**
   * The name TrenchScanner already has for this wallet (user ask 2026-10-23): a KOL, a known
   * side, an exchange, or a cached Helius identity. Absent when it has none.
   */
  name?: string;
  /** A KOL's X picture, as a path on this API (kolRoster.ts). Absent otherwise. */
  avatar?: string;
  /** Present and true when `name` is a KOL's or a KOL's known side. */
  kol?: boolean;
}

/** What TrenchScanner calls a fee wallet: walletNames.ts `feeWalletNames`. */
export type FeeWalletName = Pick<CardFeeRecipient, "name" | "avatar" | "kol">;

/** A TokenSage recipient before a Pump.fun charity name is applied. */
export interface ParsedFeeRecipient extends CardFeeRecipient {
  kind: string | null;
  /** True when `label` is an organization or login, not a shortened address. */
  named: boolean;
  address: string | null;
  /** A donation PDA's donate.gg config id (TokenSage `charity_config_id`), for its charity names. */
  configId?: string | null;
}

function shortAddress(address: string): string {
  return address.length > 10 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address;
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.replace(/\s+/g, " ").trim();
  return name || null;
}

/** A display name. A pubkey is an address, not an organization. */
function realName(value: unknown): string | null {
  const name = text(value);
  if (!name || !/\p{L}/u.test(name) || BASE58.test(name)) return null;
  return name.length > 80 ? name.slice(0, 80).trimEnd() : name;
}

function wholeBps(value: unknown): number | null {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^-?\d+$/.test(value.trim())
        ? Number(value.trim())
        : Number.NaN;
  if (!Number.isInteger(n) || n <= 0 || n > 10_000) return null;
  return n;
}

function shareBps(row: Record<string, unknown>): number | null {
  for (const key of ["share_bps", "shareBps", "bps"] as const) {
    if (row[key] === 0 || row[key] === "0") return 0;
    const n = wholeBps(row[key]);
    if (n != null) return n;
  }
  const share = row.share;
  if (share === 0) return 0;
  if (typeof share !== "number" || !(share > 0)) return null;
  if (share <= 1) return Math.round(share * 10_000);
  if (share <= 100) return Math.round(share * 100);
  return wholeBps(share);
}

/**
 * TokenSage `market.creator_fee.recipients` as labels a card can show. A named field wins.
 * A recipient with no name is the address shortened. A recipient with neither is left out,
 * so the card never renders a blank name. A zero share is not a recipient.
 */
export function feeRecipientsFromAnalysis(value: unknown): ParsedFeeRecipient[] {
  if (!Array.isArray(value)) return [];
  const out: ParsedFeeRecipient[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    const bps = shareBps(row);
    if (bps === 0) continue;
    const address = typeof row.address === "string" && BASE58.test(row.address) ? row.address : null;
    const name =
      realName(row.name) ??
      realName(row.charity_name) ??
      realName(row.charityName) ??
      realName(row.github_login) ??
      realName(row.label);
    const label = name ?? (address ? shortAddress(address) : null);
    if (!label) continue;
    const kind = text(row.kind);
    const configId =
      typeof row.charity_config_id === "string" && BASE58.test(row.charity_config_id)
        ? row.charity_config_id
        : null;
    out.push({
      label,
      bps,
      kind: kind ? kind.slice(0, 20) : null,
      named: name !== null,
      address,
      ...(configId ? { configId } : {}),
    });
    if (out.length >= 10) break;
  }
  return out;
}

function cardRecipient(
  label: string,
  bps: number | null,
  charity: boolean,
  wallet?: FeeWalletName,
): CardFeeRecipient {
  return {
    label,
    bps,
    ...(charity ? { charity: true } : {}),
    ...(!charity && wallet?.name ? { name: wallet.name } : {}),
    ...(!charity && wallet?.name && wallet.avatar ? { avatar: wallet.avatar } : {}),
    ...(!charity && wallet?.name && wallet.kol ? { kol: true } : {}),
  };
}

export function cardFeeRecipients(list: readonly ParsedFeeRecipient[]): CardFeeRecipient[] {
  return list.map((r) => cardRecipient(r.label, r.bps, r.kind === "charity", r));
}

/**
 * Each recipient with TrenchScanner's own name for its wallet (user ask 2026-10-23). A recipient
 * that already carries an organization or login, or a charity's share, keeps what it has.
 */
export function withFeeWalletNames(
  list: readonly ParsedFeeRecipient[],
  names: ReadonlyMap<string, FeeWalletName>,
): ParsedFeeRecipient[] {
  return list.map((r) => {
    const known = r.address && !r.named && r.kind !== "charity" ? names.get(r.address) : undefined;
    return known?.name ? { ...r, ...known } : r;
  });
}

function charitySlots(chain: readonly ParsedFeeRecipient[], used: ReadonlySet<number>): number[] {
  return chain.flatMap((recipient, index) => {
    if (used.has(index)) return [];
    if (recipient.kind === "charity") return [index];
    if (!recipient.named && recipient.kind !== "creator" && recipient.kind !== "github") return [index];
    return [];
  });
}

/**
 * Pump.fun's charity names onto the chain recipients. An address match wins. Otherwise names
 * fill charity slots only when the counts agree, so one name is never copied onto every
 * recipient. Chain basis points stay when the read had them. No chain recipients yet: the
 * pump list is the list.
 */
export function mergeCharityShares(
  chain: readonly ParsedFeeRecipient[],
  pump: readonly PumpCharityShare[],
): CardFeeRecipient[] {
  if (pump.length === 0) return cardFeeRecipients(chain);
  if (chain.length === 0) return pump.map((share) => cardRecipient(share.name, share.bps, true));
  const labels = chain.map((recipient) => recipient.label);
  const bps = chain.map((recipient) => recipient.bps);
  const charity = chain.map((recipient) => recipient.kind === "charity");
  const used = new Set<number>();
  const leftover: PumpCharityShare[] = [];
  for (const share of pump) {
    const index =
      share.address === null
        ? -1
        : chain.findIndex(
            (recipient, i) =>
              !used.has(i) && recipient.address !== null && recipient.address === share.address,
          );
    if (index < 0) {
      leftover.push(share);
      continue;
    }
    used.add(index);
    charity[index] = true;
    if (!chain[index]!.named) labels[index] = share.name;
    if (bps[index] == null) bps[index] = share.bps;
  }
  const slots = charitySlots(chain, used);
  if (leftover.length > 0 && leftover.length === slots.length) {
    leftover.forEach((share, n) => {
      const index = slots[n]!;
      charity[index] = true;
      if (!chain[index]!.named) labels[index] = share.name;
      if (bps[index] == null) bps[index] = share.bps;
    });
  }
  return chain.map((recipient, index) =>
    cardRecipient(labels[index]!, bps[index] ?? null, charity[index]!, recipient),
  );
}
