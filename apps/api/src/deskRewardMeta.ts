import { prisma } from "@trenchscanner/core";
import type { OtcRewardCoin } from "./feeDesks.js";

/** Token fields merged onto an OTC reward coin when the scanner has tracked the mint. */
export type DeskRewardCoin = OtcRewardCoin & {
  name?: string | null;
  symbol?: string | null;
  imageUrl?: string | null;
};

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function safeHttps(url: string | null | undefined): string | null {
  const t = url?.trim();
  return t?.startsWith("https://") ? t : null;
}

/**
 * Loads name, symbol, and image for reward mints from Token. Rewards without a mint, or a mint
 * the scanner has not stored yet, keep the roster label only.
 */
export async function enrichDeskRewards(
  rewards: readonly OtcRewardCoin[] | null | undefined,
): Promise<DeskRewardCoin[] | null> {
  if (!rewards?.length) return null;
  const mints = [
    ...new Set(
      rewards.map((r) => r.mint).filter((m): m is string => typeof m === "string" && BASE58.test(m)),
    ),
  ];
  const meta = new Map<string, { name: string | null; symbol: string | null; imageUrl: string | null }>();
  if (mints.length > 0) {
    const rows = await prisma.token.findMany({
      where: { mintAddress: { in: mints } },
      select: { mintAddress: true, name: true, symbol: true, imageUrl: true },
    });
    for (const row of rows) {
      meta.set(row.mintAddress, {
        name: row.name?.trim() || null,
        symbol: row.symbol?.trim() || null,
        imageUrl: safeHttps(row.imageUrl),
      });
    }
  }
  return rewards.map((reward) => {
    const m = reward.mint && BASE58.test(reward.mint) ? meta.get(reward.mint) : undefined;
    if (!m) return reward;
    return {
      ...reward,
      name: m.name,
      symbol: m.symbol,
      imageUrl: m.imageUrl,
    };
  });
}

/** Enriches deskRewards on every fee in the map when any coin names a reward mint. */
export async function enrichCreatorFeeDeskRewards(
  fees: Map<string, { deskRewards?: OtcRewardCoin[] | null }>,
): Promise<void> {
  const mints = new Set<string>();
  for (const fee of fees.values()) {
    for (const reward of fee.deskRewards ?? []) {
      const mint = reward.mint;
      if (mint && BASE58.test(mint)) mints.add(mint);
    }
  }
  if (mints.size === 0) return;
  const rows = await prisma.token.findMany({
    where: { mintAddress: { in: [...mints] } },
    select: { mintAddress: true, name: true, symbol: true, imageUrl: true },
  });
  const meta = new Map(
    rows.map((row) => [
      row.mintAddress,
      {
        name: row.name?.trim() || null,
        symbol: row.symbol?.trim() || null,
        imageUrl: safeHttps(row.imageUrl),
      },
    ]),
  );
  for (const fee of fees.values()) {
    if (!fee.deskRewards?.length) continue;
    fee.deskRewards = fee.deskRewards.map((reward) => {
      const mint = reward.mint;
      if (!mint || !BASE58.test(mint)) return reward;
      const m = meta.get(mint);
      if (!m) return reward;
      return { ...reward, name: m.name, symbol: m.symbol, imageUrl: m.imageUrl };
    });
  }
}
