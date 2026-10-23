import type { Card, Token } from "./api";
import {
  charityCompact,
  creatorFeeLine,
  feeCharities,
  feeBadge,
  feeRecipientCaption,
  holderRewardTaxLabel,
  shownCharityName,
  shownRewardLabels,
} from "./components/AlertCard";
import { deskRewardTokenLabel, hasOtcDeskRewards } from "./deskRewardDisplay";

type Fee = NonNullable<Token["creatorFee"]>;

/** What the Pro token view's Creator reward square shows. `empty` uses the same dash as At detection. */
export interface CreatorRewardFigure {
  value: string;
  /** A second line, the way At alert shows Peak. Null when the value already says it. */
  detail: string | null;
  /** The second line under the OTC Desks logos: `detail` without the coin names, which the logos'
   * tooltips carry (user ask 2026-10-22). */
  logoDetail: string | null;
  /** The gift tooltip: TokenSage, the charity name, and the OTC desk sentence. */
  title: string;
  empty: boolean;
  /** Pro token square label; OTC desk coins use a holder-rewards heading. */
  squareLabel: string;
  /** When true, the square renders icons and names instead of `value` alone. */
  otcDesk: boolean;
}

function coinLabels(fee: Fee | null | undefined): string[] {
  const rewards = fee?.deskRewards;
  if (rewards?.length) return rewards.map((reward) => deskRewardTokenLabel(reward));
  return shownRewardLabels(fee);
}

function coinValue(labels: readonly string[]): string {
  const joined = labels.join(" · ");
  return joined.length <= 28 ? joined : `${labels.length} coins`;
}

function headline(fee: Fee, coins: readonly string[], tax: string | null): string {
  switch (fee.destination) {
    case "holder_rewards":
      // The reward token is the holder reward. "Holders" with nothing beside it is a blank slot.
      if (coins.length) return coinValue(coins);
      return tax ? `Holders ${tax}` : "Holders";
    case "cashback":
      return "Cashback";
    case "wallet":
    case "split": {
      // An OTC Desks coin whose reward coins are not loaded yet (user report 2026-10-23).
      if (fee.deskLine?.trim()) return "OTC Desks";
      if (fee.destination === "split") return "Split";
      // One wallet we know by name: its name, the way a holder list shows it (user ask 2026-10-23).
      const named = fee.recipients?.length === 1 ? fee.recipients[0]!.name?.trim() : null;
      return named || "Wallet";
    }
    case "social":
    case "x":
    case "x_account":
      return "Social";
    case "charity": {
      // The first charity's name, cut to fit by the square, and "+1" for a second; the tooltip names
      // each and its split (user ask 2026-10-23).
      const compact = charityCompact(fee);
      if (compact) return compact;
      const named = feeRecipientCaption(fee.recipients) ?? null;
      if (named && named.length <= 42) return named;
      return "Charity";
    }
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
  const otcDesk = hasOtcDeskRewards(fee) && coins.length > 0;
  if (!badge && coins.length === 0) {
    return {
      value: "–",
      detail: null,
      logoDetail: null,
      title: line ?? "No creator reward is stored",
      empty: true,
      squareLabel: "Creator reward",
      otcDesk: false,
    };
  }
  const value = fee ? headline(fee, coins, tax) : coinValue(coins);
  const parts: string[] = [];
  const charities = feeCharities(fee);
  // A wallet's addresses show here and in the tooltip, not on the card (user ask 2026-10-23).
  const recipients =
    fee?.destination === "split" || fee?.destination === "wallet"
      ? feeRecipientCaption(fee.recipients)
      : null;
  if (recipients && recipients !== value) parts.push(recipients);
  else if (charities.length > 1) parts.push(`${charities.length} charities`);
  else if (charities.length === 0 && charity && !value.includes(charity)) parts.push(charity);
  const logoParts = [...parts];
  if (coins.length > 0 && !value.includes(coins[0]!)) parts.push(coins.join(", "));
  if (tax && coins.length > 0 && !value.includes(tax)) {
    parts.push(tax);
    logoParts.push(tax);
  }
  return {
    value,
    detail: parts.length > 0 ? parts.join(" · ") : null,
    logoDetail: logoParts.length > 0 ? logoParts.join(" · ") : null,
    title: badge?.title ?? line ?? "Creator reward",
    empty: false,
    squareLabel: otcDesk ? "Holder Rewards: OTC Desks" : "Creator reward",
    otcDesk,
  };
}

type DeskReward = { label: string; mint: string | null };
type FeeRecipient = { label: string; bps: number | null; charity?: boolean };

type DeskView = {
  feeDesk?: string | null;
  feeRewards?: DeskReward[] | null;
  /** The token page's sage read. Its charity name is copied onto the card the square reads. */
  read?: {
    creatorFee?: {
      destination?: string | null;
      charityName?: string | null;
      recipients?: { label?: string | null; share?: number | null; kind?: string | null }[] | null;
    } | null;
  } | null;
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

function sameRecipients(a: FeeRecipient[] | null, b: FeeRecipient[] | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every(
    (recipient, i) =>
      recipient.label === b[i]?.label &&
      recipient.bps === b[i]?.bps &&
      Boolean(recipient.charity) === Boolean(b[i]?.charity),
  );
}

/** Sage shares are fractions (0.99 is 99%). A blank label is not a recipient. */
function recipientsFromSage(view: DeskView): FeeRecipient[] | null {
  const list = view?.read?.creatorFee?.recipients;
  if (!list?.length) return null;
  const recipients = list.flatMap((recipient) => {
    const label = recipient.label?.trim();
    if (!label) return [];
    const share = recipient.share;
    const bps = typeof share === "number" && share > 0 && share <= 1 ? Math.round(share * 10_000) : null;
    return [recipient.kind === "charity" ? { label, bps, charity: true } : { label, bps }];
  });
  return recipients.length ? recipients : null;
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
  const charityName =
    fee?.destination === "charity"
      ? (shownCharityName(fee.charityName) ??
        shownCharityName(view?.read?.creatorFee?.charityName) ??
        fee.charityName ??
        null)
      : (fee?.charityName ?? null);
  const recipients = fee?.recipients?.length ? fee.recipients : recipientsFromSage(view);
  const sameCharity = (fee?.charityName ?? null) === (charityName ?? null);
  const sameDesk =
    (cardDesk?.line ?? null) === (desk?.line ?? null) &&
    sameRewards(cardDesk?.rewards ?? null, desk?.rewards ?? null);
  const samePeople = sameRecipients(fee?.recipients ?? null, recipients);
  if (sameCharity && sameDesk && samePeople) return card;
  return {
    ...card,
    token: {
      ...card.token,
      creatorFee: {
        destination: fee?.destination ?? null,
        summary: fee?.summary ?? null,
        bps: fee?.bps ?? null,
        charityName,
        recipients,
        deskLine: desk?.line ?? null,
        deskRewards: desk?.rewards ?? null,
      },
    },
  };
}
