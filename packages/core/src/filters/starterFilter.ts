import type { Env } from "../config/env.js";

/**
 * The filter every new account starts with.
 *
 * An account with no filters produces no alerts, which is a bad first impression of a product
 * whose entire job is producing alerts: the Live Feed sits empty and nothing explains that you
 * have to build something first. So a new user gets one working filter immediately, and can edit
 * or delete it like any other.
 *
 * The values are a deliberately middle setting - loose enough that the feed actually moves,
 * strict enough that what arrives is worth looking at:
 *
 *  - 40% fresh top-10 wallets: up to four of the ten biggest holders may be wallets funded in the
 *    last day. Some is normal on a launch this young; most of them is a sniper farm.
 *  - 60% empty top-10 wallets: the substance counterpart. Wallets can be aged cheaply, but
 *    funding them with a real portfolio cannot be, so this is the harder one to fake - and it is
 *    set looser because an unpriceable holding reads as empty, which overstates it.
 *  - 0.5 minutes: old enough to have been seen by a scan cycle, which is what stops the very
 *    first snapshot of a token being treated as a trend.
 *  - RugCheck 70: excludes the genuinely dangerous without demanding a clean bill of health that
 *    almost nothing this young has.
 *
 * Mirrored in the dashboard's "Default" template (CultScreener,
 * trenches/src/components/FilterTemplates.tsx) so somebody who deletes this filter can rebuild
 * exactly it. If you change a number here, change it there.
 */
export const STARTER_FILTER_NAME = "Default";

export interface StarterFilterInput {
  name: string;
  mcapMin: number;
  mcapMax: number;
  maxFreshTop10WalletPct: number;
  maxEmptyTop10WalletPct: number;
  minTokenAgeMinutes: number;
  maxRiskScore: number;
}

/**
 * Market cap is taken from the platform's own advertised band rather than hardcoded: a starter
 * filter narrower than the range the scanner even looks at would silently see nothing, and one
 * wider than it would imply a reach the product does not have.
 */
export function starterFilterInput(env: Env): StarterFilterInput {
  return {
    name: STARTER_FILTER_NAME,
    mcapMin: env.MCAP_FILTER_MIN,
    mcapMax: env.MCAP_FILTER_MAX,
    maxFreshTop10WalletPct: 40,
    maxEmptyTop10WalletPct: 60,
    minTokenAgeMinutes: 0.5,
    maxRiskScore: 70,
  };
}
