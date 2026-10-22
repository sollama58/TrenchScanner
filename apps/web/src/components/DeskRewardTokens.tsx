import { useEffect, useMemo, useState } from "react";
import type { SearchMarketPatch } from "../cardSearch";
import { deskRewardName, deskRewardTokenLabel, type DeskRewardView } from "../deskRewardDisplay";
import { keptDeskRewardMeta, loadDeskRewardMeta } from "../deskRewardMeta";
import { TokenImage } from "./TokenImage";

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function needsMeta(reward: DeskRewardView): boolean {
  const mint = reward.mint?.trim();
  if (!mint || !BASE58.test(mint)) return false;
  return !reward.symbol?.trim() && !reward.name?.trim() && !reward.imageUrl?.startsWith("https://");
}

function mergePatch(reward: DeskRewardView, patch: SearchMarketPatch | undefined): DeskRewardView {
  if (!patch || patch.mint !== reward.mint) return reward;
  return {
    ...reward,
    symbol: reward.symbol ?? patch.symbol,
    name: reward.name ?? patch.name,
    imageUrl: reward.imageUrl ?? patch.imageUrl,
  };
}

function keptPatches(mints: string): Map<string, SearchMarketPatch> {
  const out = new Map<string, SearchMarketPatch>();
  for (const mint of mints ? mints.split(",") : []) {
    const patch = keptDeskRewardMeta(mint);
    if (patch) out.set(mint, patch);
  }
  return out;
}

function useDeskRewardPatches(rewards: readonly DeskRewardView[]): DeskRewardView[] {
  const mints = useMemo(
    () => [...new Set(rewards.filter(needsMeta).map((r) => r.mint!.trim()))].slice(0, 30).join(","),
    [rewards],
  );
  // What the page already has paints at once; a remounted card doesn't ask again (deskRewardMeta.ts).
  const [patches, setPatches] = useState<Map<string, SearchMarketPatch>>(() => keptPatches(mints));
  useEffect(() => {
    if (!mints) return;
    let stop = false;
    void loadDeskRewardMeta(mints.split(",")).then((found) => {
      if (stop || found.size === 0) return;
      setPatches((prev) => {
        const next = new Map(prev);
        for (const [mint, hit] of found) next.set(mint, hit);
        return next;
      });
    });
    return () => {
      stop = true;
    };
  }, [mints]);
  return useMemo(
    () => rewards.map((reward) => mergePatch(reward, reward.mint ? patches.get(reward.mint) : undefined)),
    [rewards, patches],
  );
}

function RewardAvatar({ reward, px }: { reward: DeskRewardView; px: number }) {
  const name = deskRewardName(reward);
  const initials = name.replace(/^\$/, "").slice(0, 2) || "?";
  return (
    <TokenImage
      url={reward.imageUrl}
      size={px * 2}
      className="desk-reward-avatar"
      width={px}
      height={px}
      fallback={<span className="desk-reward-avatar placeholder">{initials}</span>}
    />
  );
}

function RewardLink({
  reward,
  showName,
  compact,
}: {
  reward: DeskRewardView;
  showName: boolean;
  compact?: boolean;
}) {
  const label = deskRewardTokenLabel(reward);
  const mint = reward.mint?.trim();
  const inner = (
    <>
      <RewardAvatar reward={reward} px={compact ? 14 : 16} />
      {showName && <span className="desk-reward-name">{label}</span>}
    </>
  );
  if (mint && BASE58.test(mint)) {
    return (
      <a
        className="desk-reward-token"
        href={`https://solscan.io/token/${mint}`}
        target="_blank"
        rel="noopener noreferrer"
        title={mint}
      >
        {inner}
      </a>
    );
  }
  return <span className="desk-reward-token">{inner}</span>;
}

/**
 * OTC Desks reward coins with icons and names. On cards, `compact` shows at most two then a +
 * hover menu; the pro token square uses the full row without compact.
 */
export function DeskRewardTokens({
  rewards,
  compact = false,
  maxVisible = 2,
  className = "",
}: {
  rewards: readonly DeskRewardView[];
  compact?: boolean;
  maxVisible?: number;
  className?: string;
}) {
  const filled = useDeskRewardPatches(rewards);
  if (!filled.length) return null;
  const visible = compact ? filled.slice(0, maxVisible) : filled;
  const rest = compact && filled.length > maxVisible ? filled.slice(maxVisible) : [];
  const more = rest.length;
  return (
    <span className={`desk-reward-tokens${compact ? " compact" : ""}${className ? ` ${className}` : ""}`}>
      {visible.map((reward, index) => (
        <RewardLink
          key={`${reward.mint ?? reward.label}-${index}`}
          reward={reward}
          showName
          compact={compact}
        />
      ))}
      {more > 0 && (
        <span className="desk-reward-more-wrap">
          <button
            type="button"
            className="desk-reward-more"
            aria-haspopup="true"
            aria-label={`${more} more reward tokens`}
          >
            +{more}
          </button>
          <span className="desk-reward-more-menu" role="menu">
            {rest.map((reward, index) => (
              <span key={`${reward.mint ?? reward.label}-more-${index}`} role="none">
                <RewardLink reward={reward} showName compact={false} />
              </span>
            ))}
          </span>
        </span>
      )}
    </span>
  );
}
