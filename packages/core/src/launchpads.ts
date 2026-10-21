/**
 * Which launchpad a coin came from, as one spelling across sources: Jupiter's `launchpad`
 * ("pump.fun", "stonkfun"), GeckoTerminal's dex id ("pump-fun", "stonkfun"), PumpPortal's `pool`
 * ("pump"). Recorded on Token.launchpad at discovery, and read by the launchpadStonks model input
 * and the filters' launchpad option.
 *
 * Stonks (stonk.fun) launches on Raydium's LaunchLab: a bonding curve DexScreener does not list
 * (GeckoTerminal and Jupiter call it "stonkfun"), graduating into a Raydium CPMM pool, quoted in
 * whatever coin the creator picked (ASTER, TSLAx, NEAR, USDC...). Its coins are Token-2022 mints
 * of 1B with a 3% transfer fee. Seen 2026-10-16: 13 of Jupiter's 100 trending coins of the hour.
 */
export const PUMPFUN_LAUNCHPAD = "pumpfun";
export const STONKS_LAUNCHPAD = "stonks";

/** The launchpads whose launches discovery takes. Anything else Jupiter lists is left out. */
export const SCANNED_LAUNCHPADS: ReadonlySet<string> = new Set([PUMPFUN_LAUNCHPAD, STONKS_LAUNCHPAD]);

/** The filter's launchpad choices, with their names as shown. */
export const LAUNCHPAD_LABELS: Readonly<Record<string, string>> = {
  [PUMPFUN_LAUNCHPAD]: "Pump.fun",
  [STONKS_LAUNCHPAD]: "Stonks",
};

const ALIASES: Readonly<Record<string, string>> = {
  "pump.fun": PUMPFUN_LAUNCHPAD,
  "pump-fun": PUMPFUN_LAUNCHPAD,
  pumpfun: PUMPFUN_LAUNCHPAD,
  pump: PUMPFUN_LAUNCHPAD,
  "pump-amm": PUMPFUN_LAUNCHPAD,
  stonkfun: STONKS_LAUNCHPAD,
  "stonk.fun": STONKS_LAUNCHPAD,
  "stonk-fun": STONKS_LAUNCHPAD,
  stonks: STONKS_LAUNCHPAD,
};

/**
 * One spelling for a source's launchpad name. A name not known here is kept, lowercased (at most
 * 40 characters), so a launchpad nobody has mapped yet is still told apart from the rest.
 */
export function normalizeLaunchpad(name: unknown): string | undefined {
  if (typeof name !== "string") return undefined;
  const key = name.trim().toLowerCase();
  if (!key) return undefined;
  return ALIASES[key] ?? key.slice(0, 40);
}

/**
 * DexScreener-style venue ids of a coin still on its launchpad's bonding curve: Pump.fun's curve,
 * and Stonks' LaunchLab curve (as GeckoTerminal names it, and as the Jupiter reading is given).
 */
const CURVE_VENUES: ReadonlySet<string> = new Set(["pumpfun", "stonkfun"]);

/**
 * Curves whose pool was created with the coin. Meteora DBC and Raydium LaunchLab are homes in
 * the same way Pump.fun's curve is, but they are not Pump venues: the safety screen still does
 * not treat their liquidity as burned (isCurveVenue). DexScreener spells them meteoradbc and
 * launchlab; GeckoTerminal's meteora-dbc and raydium-launchlab are mapped onto these first.
 */
const LAUNCH_HOME_CURVES: ReadonlySet<string> = new Set(["pumpfun", "stonkfun", "meteoradbc", "launchlab"]);

/** Whether a venue id is a launchpad's bonding curve. Pump.fun and Stonks only. */
export function isCurveVenue(dexId: string | undefined): boolean {
  return dexId !== undefined && CURVE_VENUES.has(dexId);
}

/** Whether a venue id is the coin's own bonding curve, including Meteora DBC and LaunchLab. */
export function isLaunchHomeCurve(dexId: string | undefined): boolean {
  return dexId !== undefined && LAUNCH_HOME_CURVES.has(dexId);
}

/** The launchpad a venue id gives away, when it does (a graduated Raydium pool doesn't). */
export function launchpadFromVenue(dexId: string | undefined): string | undefined {
  if (dexId === "pumpfun" || dexId === "pumpswap") return PUMPFUN_LAUNCHPAD;
  if (dexId === "stonkfun") return STONKS_LAUNCHPAD;
  return undefined;
}
