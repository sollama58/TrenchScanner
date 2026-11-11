/**
 * Which launchpad a coin came from, as one spelling across sources: Jupiter's `launchpad`
 * ("pump.fun", "stonkfun", "letsbonk.fun", "raydium-launchlab"), GeckoTerminal's dex id
 * ("pump-fun", "stonkfun"), PumpPortal's `pool` ("pump", "bonk"). Recorded on Token.launchpad at
 * discovery, and read by the launchpadStonks model input, the filters' launchpad option and the
 * launchpad badge on the dashboard.
 *
 * Stonks (stonk.fun) launches on Raydium's LaunchLab: a bonding curve DexScreener does not list
 * (GeckoTerminal and Jupiter call it "stonkfun"), graduating into a Raydium CPMM pool, quoted in
 * whatever coin the creator picked (ASTER, TSLAx, NEAR, USDC...). Its coins are Token-2022 mints
 * of 1B with a 3% transfer fee. Seen 2026-10-16: 13 of Jupiter's 100 trending coins of the hour.
 *
 * Float (floatlaunch.xyz, mints mostly ending "fLoat") and Bonk (letsbonk.fun) launch on LaunchLab
 * too, and so do thousands of smaller platforms (user report 2026-11-11: Float coins never reached
 * the scan). Jupiter names most of them "raydium-launchlab"; which one a coin came from is the
 * pool's platform config (Jupiter's `partnerConfig`; at byte 173 of the pool, launchLab.ts),
 * mapped below. Every LaunchLab launchpad is handled the way Stonks is (isLaunchLabLaunchpad).
 */
export const PUMPFUN_LAUNCHPAD = "pumpfun";
export const STONKS_LAUNCHPAD = "stonks";
export const FLOAT_LAUNCHPAD = "float";
export const BONK_LAUNCHPAD = "bonk";
/** A LaunchLab coin from a platform not told apart here (or not yet known). */
export const LAUNCHLAB_LAUNCHPAD = "launchlab";

/** Launchpads whose coins start on a Raydium LaunchLab curve and graduate into a Raydium pool. */
const LAUNCHLAB_LAUNCHPADS: ReadonlySet<string> = new Set([
  STONKS_LAUNCHPAD,
  FLOAT_LAUNCHPAD,
  BONK_LAUNCHPAD,
  LAUNCHLAB_LAUNCHPAD,
]);

/** Whether a launchpad launches on Raydium LaunchLab (Stonks, Float, Bonk and the rest). */
export function isLaunchLabLaunchpad(launchpad: string | null | undefined): boolean {
  return typeof launchpad === "string" && LAUNCHLAB_LAUNCHPADS.has(launchpad);
}

/** The launchpads whose launches discovery takes. Anything else Jupiter lists is left out. */
export const SCANNED_LAUNCHPADS: ReadonlySet<string> = new Set([PUMPFUN_LAUNCHPAD, ...LAUNCHLAB_LAUNCHPADS]);

/** The filter's launchpad choices and the dashboard's badge, with their names as shown. */
export const LAUNCHPAD_LABELS: Readonly<Record<string, string>> = {
  [PUMPFUN_LAUNCHPAD]: "Pump.fun",
  [STONKS_LAUNCHPAD]: "Stonks",
  [FLOAT_LAUNCHPAD]: "Float",
  [BONK_LAUNCHPAD]: "Bonk",
  [LAUNCHLAB_LAUNCHPAD]: "LaunchLab",
};

/**
 * LaunchLab platform configs whose launchpad is known. Anyone can create a config and name it
 * "Float" or "StonkFun" (5,600 configs on 2026-11-11, dozens of them so named), so a config's own
 * name is never trusted: these are the platforms' working configs, each checked by the pools under
 * it (2026-11-11: Float's 2TDP… 4,874 pools, 1,621 of them on "…fLoat" mints; Stonks' 6Bwh… 142,533
 * and 4E87… 50,777, "…stnk" mints; Bonk's FfYe… over a million). Any other config is
 * LAUNCHLAB_LAUNCHPAD unless Jupiter names the launchpad itself.
 */
const LAUNCHLAB_PLATFORM_LAUNCHPADS: Readonly<Record<string, string>> = {
  "2TDPJJPV6nvTEqXABxrqno6Uzpipxxvh1zjLN3SMYn69": FLOAT_LAUNCHPAD,
  "7paQR4MLZcGdG8ZYAyj9Qu2UsJgXmNVQGha7g1gim1sG": FLOAT_LAUNCHPAD,
  CKpEUk5SRk8CUNhhxaVPKtzKUKLgQe2tQHPH2eXWtaGR: FLOAT_LAUNCHPAD,
  "8qiizfdg7zd63EK9ajiSHeFgKhuQzx57DudwZZkpVp1H": FLOAT_LAUNCHPAD,
  // The config Float's own FLOAT coin launched under.
  s1ChXD2gHFkr6QJRCU24mbqgcUmSXLRwgqXKFrtrizJ: FLOAT_LAUNCHPAD,
  "6BwHHDg3u1854jC8PDLXvR4spTcLNaoBxLJNGC4nTESt": STONKS_LAUNCHPAD,
  "4E876qZTE9FJMrBzgVtBrSrzz2TLivB5Y5QXPjB4gZL7": STONKS_LAUNCHPAD,
  FfYek5vEz23cMkWsdJwG2oa6EphsvXSHrGpdALN4g6W1: BONK_LAUNCHPAD,
  BuM6KDpWiTcxvrpXywWFiw45R2RNH8WURdvqoTDV1BW4: BONK_LAUNCHPAD,
  "82NMHVCKwehXgbXMyzL41mvv3sdkypaMCtTxvJ4CtTzm": BONK_LAUNCHPAD,
};

/** The launchpad of a LaunchLab coin launched under `platformConfig`: a known one, else LaunchLab. */
export function launchpadOfLaunchLabPlatform(platformConfig: unknown): string {
  const known =
    typeof platformConfig === "string" && Object.hasOwn(LAUNCHLAB_PLATFORM_LAUNCHPADS, platformConfig)
      ? LAUNCHLAB_PLATFORM_LAUNCHPADS[platformConfig]
      : undefined;
  return known ?? LAUNCHLAB_LAUNCHPAD;
}

/**
 * A coin's launchpad from a source that names one and, for a LaunchLab coin, its platform config
 * (Jupiter's `launchpad` and `partnerConfig`). A known config names its launchpad over the source's
 * generic "raydium-launchlab"; a launchpad the source names itself (stonkfun, letsbonk.fun) stands.
 */
export function resolveLaunchpad(name: unknown, platformConfig?: unknown): string | undefined {
  const launchpad = normalizeLaunchpad(name);
  if (launchpad !== LAUNCHLAB_LAUNCHPAD) return launchpad;
  return launchpadOfLaunchLabPlatform(platformConfig);
}

/**
 * A coin's launchpad from what the scan recorded (Token.launchpad), what its market source names
 * now and what its venue gives away (launchpadFromVenue), in that order: the record stands, read
 * in today's spelling, except that a LaunchLab platform named now replaces a generic LaunchLab.
 */
export function bestLaunchpad(
  recorded: string | null | undefined,
  named: string | undefined,
  venue: string | undefined,
): string | undefined {
  const known = normalizeLaunchpad(recorded);
  const next = named ?? venue;
  if (known === LAUNCHLAB_LAUNCHPAD && isLaunchLabLaunchpad(next)) return next;
  return known ?? next;
}

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
  stonk: STONKS_LAUNCHPAD,
  "raydium-launchlab": LAUNCHLAB_LAUNCHPAD,
  launchlab: LAUNCHLAB_LAUNCHPAD,
  "letsbonk.fun": BONK_LAUNCHPAD,
  "letsbonk-fun": BONK_LAUNCHPAD,
  letsbonk: BONK_LAUNCHPAD,
  "bonk.fun": BONK_LAUNCHPAD,
  bonkfun: BONK_LAUNCHPAD,
  bonk: BONK_LAUNCHPAD,
  float: FLOAT_LAUNCHPAD,
  floatlaunch: FLOAT_LAUNCHPAD,
  "floatlaunch.xyz": FLOAT_LAUNCHPAD,
};

/**
 * One spelling for a source's launchpad name. A name not known here is kept, lowercased (at most
 * 40 characters), so a launchpad nobody has mapped yet is still told apart from the rest.
 */
export function normalizeLaunchpad(name: unknown): string | undefined {
  if (typeof name !== "string") return undefined;
  const key = name.trim().toLowerCase();
  if (!key) return undefined;
  return (Object.hasOwn(ALIASES, key) ? ALIASES[key] : undefined) ?? key.slice(0, 40);
}

/**
 * DexScreener-style venue ids of a coin still on its launchpad's bonding curve: Pump.fun's curve,
 * Stonks' LaunchLab curve (as GeckoTerminal names it, and as the Jupiter reading is given), and any
 * other LaunchLab curve (DexScreener's and our spelling; GeckoTerminal's raydium-launchlab is
 * mapped onto it). A LaunchLab curve is the coin's own home, as Stonks' always was: it was left out
 * behind LAUNCH_HOME_CLOCK until 2026-11-11, which read a Float coin on its curve as graduated
 * (GeckoTerminal folded the curve into "raydium") or as having no venue at all.
 */
const CURVE_VENUES: ReadonlySet<string> = new Set(["pumpfun", "stonkfun", "launchlab"]);

/**
 * Curves whose pool was created with the coin. Meteora DBC is a home in the same way Pump.fun's
 * curve is, but it is not a curve the screen knows: the safety screen still does not treat its
 * liquidity as burned (isCurveVenue), and its clock stays behind LAUNCH_HOME_CLOCK. DexScreener
 * spells it meteoradbc; GeckoTerminal's meteora-dbc is mapped onto it first.
 */
const LAUNCH_HOME_CURVES: ReadonlySet<string> = new Set(["pumpfun", "stonkfun", "meteoradbc", "launchlab"]);

/** Whether a venue id is a launchpad's bonding curve: Pump.fun's or a Raydium LaunchLab one. */
export function isCurveVenue(dexId: string | undefined): boolean {
  return dexId !== undefined && CURVE_VENUES.has(dexId);
}

/** Whether a venue id is the coin's own bonding curve, including Meteora DBC. */
export function isLaunchHomeCurve(dexId: string | undefined): boolean {
  return dexId !== undefined && LAUNCH_HOME_CURVES.has(dexId);
}

/**
 * The launchpad a venue id gives away, when it does (a graduated Raydium pool doesn't). A plain
 * LaunchLab curve says LaunchLab, not which platform: the scan's own record names that.
 */
export function launchpadFromVenue(dexId: string | undefined): string | undefined {
  if (dexId === "pumpfun" || dexId === "pumpswap") return PUMPFUN_LAUNCHPAD;
  if (dexId === "stonkfun") return STONKS_LAUNCHPAD;
  if (dexId === "launchlab") return LAUNCHLAB_LAUNCHPAD;
  return undefined;
}

/** The DexScreener-style venue of a LaunchLab launchpad's coin on its curve. */
export function launchLabCurveVenue(launchpad: string | undefined): string | undefined {
  if (launchpad === STONKS_LAUNCHPAD) return "stonkfun";
  return isLaunchLabLaunchpad(launchpad) ? "launchlab" : undefined;
}
