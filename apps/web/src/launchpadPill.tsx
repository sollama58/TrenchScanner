import { LAUNCHPAD_LABELS, normalizeLaunchpad } from "@trenchscanner/core/launchpads";
import type { Card } from "./api";

/**
 * The launchpad a coin came from, as the pill beside its ticker shows it (user ask 2026-11-11:
 * mark Pump.fun, Stonks, Float and the rest). Null for a launchpad nobody has named, or one the
 * scan doesn't take, so an unknown source never reads as a launchpad.
 */
export function launchpadOf(raw: string | null | undefined): { id: string; label: string } | null {
  const id = normalizeLaunchpad(raw);
  if (!id || !Object.hasOwn(LAUNCHPAD_LABELS, id)) return null;
  return { id, label: LAUNCHPAD_LABELS[id]! };
}

const TITLES: Readonly<Record<string, string>> = {
  pumpfun: "Launched on Pump.fun",
  stonks: "Launched on Stonks (stonk.fun), a Raydium LaunchLab launchpad",
  float: "Launched on Float (floatlaunch.xyz), a Raydium LaunchLab launchpad",
  bonk: "Launched on Bonk (letsbonk.fun), a Raydium LaunchLab launchpad",
  launchlab: "Launched on Raydium LaunchLab, on a launchpad TrenchScanner doesn't name",
};

/** A small pill naming the coin's launchpad, tinted per launchpad. Nothing when it's unknown. */
export function LaunchpadPill({
  token,
  className = "",
}: {
  token: Pick<Card["token"], "launchpad">;
  className?: string;
}) {
  const pad = launchpadOf(token.launchpad);
  if (!pad) return null;
  return (
    <span
      className={`launchpad-pill launchpad-${pad.id} ${className}`}
      title={TITLES[pad.id] ?? `Launched on ${pad.label}`}
      aria-label={`Launchpad: ${pad.label}`}
    >
      {pad.label}
    </span>
  );
}
