import { Fragment } from "react";
import type { Token } from "../api";
import { shortAddress } from "../format";
import { creatorFeeSummary, feeRecipientSentence } from "./AlertCard";

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** One OTC reward coin, as the API names it. The label is the roster's ticker or a shortened mint. */
export interface DeskReward {
  label: string;
  mint: string | null;
  name?: string | null;
  symbol?: string | null;
  imageUrl?: string | null;
}

/**
 * Reward coins safe to render. A changed shape returns null so the caller keeps the sentence
 * string instead of inventing a ticker or a link.
 */
export function deskRewards(value: unknown): DeskReward[] | null {
  if (value == null) return null;
  if (!Array.isArray(value) || value.length === 0) return null;
  const rewards: DeskReward[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const row = item as Record<string, unknown>;
    const mint = typeof row.mint === "string" && BASE58.test(row.mint) ? row.mint : null;
    if (row.mint != null && row.mint !== "" && mint === null) return null;
    const raw = typeof row.label === "string" ? row.label.trim() : "";
    const label = raw || (mint ? shortAddress(mint) : "");
    if (!label) continue;
    rewards.push({ label, mint });
  }
  return rewards.length ? rewards : null;
}

function joinGap(count: number, index: number): string {
  if (index === 0) return "";
  if (count === 2) return " and ";
  return index === count - 1 ? ", and " : ", ";
}

/**
 * "OTC Desks pays holder rewards in NVDAx and TSLAx." Each coin is that token: its ticker, and a
 * Solscan link when the mint is known (the same host other token rows already use). Tooltips stay
 * the plain sentence.
 */
export function FeeRewards({ rewards }: { rewards: DeskReward[] }) {
  return (
    <>
      OTC Desks pays holder rewards in{" "}
      {rewards.map((reward, index) => (
        <Fragment key={`${reward.mint ?? reward.label}-${index}`}>
          {joinGap(rewards.length, index)}
          {reward.mint ? (
            <a
              className="fee-reward"
              href={`https://solscan.io/token/${reward.mint}`}
              target="_blank"
              rel="noopener noreferrer"
              title={reward.mint}
            >
              {reward.label}
            </a>
          ) : (
            <span className="fee-reward">{reward.label}</span>
          )}
        </Fragment>
      ))}
      .
    </>
  );
}

/** The desk sentence, with each reward mint rendered as that token when the roster named one. */
export function DeskSentence({ line, rewards }: { line?: string | null; rewards?: unknown }) {
  const coins = deskRewards(rewards);
  if (coins) return <FeeRewards rewards={coins} />;
  const text = line?.trim();
  return text ? <>{text}</> : null;
}

function stopped(text: string | null | undefined): string | null {
  const t = text?.trim().replace(/\.$/, "");
  return t ? `${t.charAt(0).toUpperCase()}${t.slice(1)}.` : null;
}

/**
 * TokenSage's sentence, then OTC Desks' reward coins. Matches `creatorFeeLine` when the rewards
 * are only a string; renders each reward mint as a token when the roster sent them.
 */
export function CreatorFeeRich({ fee }: { fee: NonNullable<Token["creatorFee"]> }) {
  const summary =
    (fee.destination === "charity" || fee.destination === "split" ? feeRecipientSentence(fee) : null) ??
    creatorFeeSummary(fee);
  const desk = stopped(fee.deskLine);
  const coins = deskRewards(fee.deskRewards);
  if (summary && desk && summary === desk) return <>{summary}</>;
  const deskNode = coins ? <FeeRewards rewards={coins} /> : desk;
  if (summary && deskNode)
    return (
      <>
        {summary} {deskNode}
      </>
    );
  if (summary) return <>{summary}</>;
  if (deskNode) return <>{deskNode}</>;
  return null;
}
