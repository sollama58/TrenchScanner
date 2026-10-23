import type { DeskReward } from "./components/FeeRewards";
import { shortAddress, tokenLabel } from "./format";

export type DeskRewardView = DeskReward & {
  name?: string | null;
  symbol?: string | null;
  imageUrl?: string | null;
};

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** True when the roster named OTC Desks reward coins for this fee read. */
export function hasOtcDeskRewards(
  fee: { deskRewards?: readonly DeskRewardView[] | null; deskLine?: string | null } | null | undefined,
): boolean {
  return Boolean(fee?.deskRewards?.length || fee?.deskLine?.trim());
}

/** Who pays a coin's holder rewards: Stonk on a Stonks reward launch, else OTC Desks. */
export function rewardHost(fee: { rewardHost?: string | null } | null | undefined): string {
  return fee?.rewardHost?.trim() || "OTC Desks";
}

/** The name beside an icon: tracked symbol/name, else roster label, else shortened mint. */
export function deskRewardName(reward: DeskRewardView): string {
  const mint = reward.mint?.trim();
  if (reward.symbol?.trim()) return `$${reward.symbol.trim().replace(/^\$+/, "")}`;
  if (reward.name?.trim()) return reward.name.trim();
  const label = reward.label?.trim();
  if (label && (!mint || label !== shortAddress(mint))) return label;
  if (mint && BASE58.test(mint)) return shortAddress(mint);
  return label || "Reward";
}

/** tokenLabel when a mint is known; otherwise deskRewardName. */
export function deskRewardTokenLabel(reward: DeskRewardView): string {
  const mint = reward.mint?.trim();
  const label = reward.label?.trim();
  if (mint && BASE58.test(mint)) {
    const fromMeta = tokenLabel({
      mintAddress: mint,
      symbol: reward.symbol ?? null,
      name: reward.name ?? null,
    });
    if (label && fromMeta === shortAddress(mint)) return label;
    return fromMeta;
  }
  return deskRewardName(reward);
}

export function deskRewardViews(rewards: readonly DeskRewardView[] | null | undefined): DeskRewardView[] {
  return rewards?.length ? [...rewards] : [];
}
