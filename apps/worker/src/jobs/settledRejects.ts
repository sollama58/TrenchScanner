import type { Env } from "@trenchscanner/core";
import { cachedMayhemMode } from "./mayhemMode.js";
import { knownPreBondSeconds, type PreBondCandidate } from "./launchTimes.js";

/**
 * Candidates the safety screen already rejects on a fact that never changes: launched in Mayhem
 * Mode, or a curve filled in under SAFETY_MIN_PREBOND_SECONDS. Read from what is already known
 * (MayhemModeCache, the launch and graduation times in memory) - no network call.
 *
 * Nothing a later read could bring changes their verdict, so the scan stops refreshing their
 * RugCheck report: the last one stands, with the reasons and holder figures it gave, and the
 * one-minute re-reads for young coins and fresh graduates over a holder cut skip them. Mayhem
 * coins are about a third of the band, and every one of them fails the top-10 cut on the Mayhem
 * agent's wallet, so each was re-read every minute for its first ten (notes/audit-2026-10-12).
 *
 * `except`: mints kept on the normal refresh anyway (a token someone has open, whose card shows the
 * live holder figures). Mapped to the fact that settles each one.
 */
export async function settledRejects(
  candidates: ReadonlyArray<PreBondCandidate>,
  env: Pick<Env, "SAFETY_MIN_PREBOND_SECONDS">,
  except: ReadonlySet<string> = new Set(),
): Promise<Map<string, "mayhem" | "preBond">> {
  const mints = candidates.map((c) => c.mintAddress).filter((m) => !except.has(m));
  const out = new Map<string, "mayhem" | "preBond">();
  for (const [mint, isMayhemMode] of await cachedMayhemMode(mints)) {
    if (isMayhemMode) out.set(mint, "mayhem");
  }
  const floor = env.SAFETY_MIN_PREBOND_SECONDS;
  if (floor > 0) {
    for (const [mint, seconds] of knownPreBondSeconds(candidates)) {
      if (seconds < floor && !except.has(mint) && !out.has(mint)) out.set(mint, "preBond");
    }
  }
  return out;
}
