import type { Card, Token } from "./api";
import { creatorFeeLine, feeBadge, holderRewardTaxLabel, shownCharityName } from "./components/AlertCard";

type Fee = NonNullable<Token["creatorFee"]>;

/** What the Pro token view's Creator reward square shows. `empty` uses the same dash as At detection. */
export interface CreatorRewardFigure {
  value: string;
  /** A second line, the way At alert shows Peak. Null when the value already says it. */
  detail: string | null;
  /** The gift tooltip: TokenSage, the charity name, and the OTC desk sentence. */
  title: string;
  empty: boolean;
}

function coinLabels(fee: Fee | null | undefined): string[] {
  const rewards = fee?.deskRewards;
  if (!rewards?.length) return [];
  return rewards.flatMap((reward) => {
    const label = reward.label?.trim();
    return label ? [label] : [];
  });
}

function coinValue(labels: readonly string[]): string {
  const joined = labels.join(" · ");
  return joined.length <= 28 ? joined : `${labels.length} coins`;
}

function headline(fee: Fee, coins: readonly string[], tax: string | null): string {
  switch (fee.destination) {
    case "holder_rewards":
      return tax ? `Holders ${tax}` : "Holders";
    case "cashback":
      return "Cashback";
    case "wallet":
      return "Wallet";
    case "split":
      return "Split";
    case "social":
    case "x":
    case "x_account":
      return "Social";
    case "charity":
      return "Charity";
    case "github":
      return "GitHub";
    case "creator":
      return "Dev";
    default:
      return coins.length > 0 ? coinValue(coins) : "Rewards";
  }
}

/**
 * Creator reward for one coin: holder rewards and the tax, fees to the dev, a charity and its
 * name, and OTC desk reward coins when the roster named them. Nothing stored is the empty dash.
 */
export function creatorRewardFigure(fee: Fee | null | undefined): CreatorRewardFigure {
  const coins = coinLabels(fee);
  const charity = fee?.destination === "charity" ? shownCharityName(fee.charityName) : null;
  const tax = fee?.destination === "holder_rewards" ? holderRewardTaxLabel(fee.bps) : null;
  const line = creatorFeeLine(fee);
  const badge = fee ? feeBadge(fee) : null;
  // An unknown destination hides the gift. A summary alone is not a reward label: the
  // square uses the same dash as a missing detection cap. A real holder, dev, charity,
  // or OTC desk still has a badge or reward coins, and those stay.
  if (!badge && coins.length === 0) {
    return {
      value: "–",
      detail: null,
      title: line ?? "No creator reward is stored",
      empty: true,
    };
  }
  const value = fee ? headline(fee, coins, tax) : coinValue(coins);
  const parts: string[] = [];
  if (charity) parts.push(charity);
  if (coins.length > 0 && !value.includes(coins[0]!)) parts.push(coins.join(", "));
  return {
    value,
    detail: parts.length > 0 ? parts.join(" · ") : null,
    title: badge?.title ?? line ?? "Creator reward",
    empty: false,
  };
}

type DeskReward = { label: string; mint: string | null };

type DeskView = {
  feeDesk?: string | null;
  feeRewards?: DeskReward[] | null;
} | null;

interface DeskPair {
  line: string | null;
  rewards: DeskReward[] | null;
}

function deskPair(
  line: string | null | undefined,
  rewards: DeskReward[] | null | undefined,
): DeskPair | null {
  const text = typeof line === "string" && line.trim() ? line.trim() : null;
  const coins = rewards?.length ? rewards : null;
  if (!text && !coins) return null;
  return { line: text, rewards: coins };
}

function sameRewards(a: DeskReward[] | null, b: DeskReward[] | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((reward, i) => reward.label === b[i]?.label && reward.mint === b[i]?.mint);
}

/**
 * The token view's card, with OTC Desks' reward coins from the sage read when the feed card
 * was built before the roster was cached. The sentence and its coins always come from the
 * same side: the sage payload once that read has a desk, otherwise the card's own pair.
 */
export function cardWithOtcDesk<T extends Card>(card: T, view: DeskView): T {
  const fee = card.token.creatorFee;
  const cardDesk = deskPair(fee?.deskLine, fee?.deskRewards);
  const sageDesk = deskPair(view?.feeDesk, view?.feeRewards);
  const desk = sageDesk ?? cardDesk;
  if (!desk) return card;
  if ((cardDesk?.line ?? null) === desk.line && sameRewards(cardDesk?.rewards ?? null, desk.rewards))
    return card;
  return {
    ...card,
    token: {
      ...card.token,
      creatorFee: {
        destination: fee?.destination ?? null,
        summary: fee?.summary ?? null,
        bps: fee?.bps ?? null,
        charityName: fee?.charityName,
        deskLine: desk.line,
        deskRewards: desk.rewards,
      },
    },
  };
}
