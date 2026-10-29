import {
  createLogger,
  discoveredCoinFromRelay,
  tokenSageEnabled,
  TokenSageClient,
  type DiscoveredCoin,
  type Env,
} from "@trenchscanner/core";

const logger = createLogger("pump-relay");

/**
 * Pump.fun's single-coin read through TokenSage's relay (GET /v1/pumpfun/coins/{ca}). Pump.fun's
 * Cloudflare has refused this service since 2026-10-22, Origin and User-Agent included (#1128),
 * while TokenSage in the same Render region is answered. A one-coin-a-minute test (check-in
 * 2026-10-29) got 5 answers of 6 while every direct read was challenged, so launch details now
 * ask the relay for a coin Pump.fun refused us (user decision that day: "test, then route via
 * TokenSage").
 *
 * At most MAX_PER_MIN coins a minute go out, under the relay's own shared cap (30, which also
 * guards TokenSage's own Pump.fun reads from a rate-based block); a launch past it falls through
 * to its metadata JSON as before.
 */
export const MAX_PER_MIN = 20;

export interface PumpRelayStats {
  asked: number;
  ok: number;
  notFound: number;
  refused: number;
  /** Of the refusals, those Cloudflare marked `cf-mitigated: challenge`. */
  challenged: number;
  unavailable: number;
  busy: number;
  /** TokenSage itself didn't answer (transport, 4xx, 5xx). */
  failed: number;
  /** Not asked: MAX_PER_MIN already went out this minute. */
  capped: number;
}

const emptyStats = (): PumpRelayStats => ({
  asked: 0,
  ok: 0,
  notFound: 0,
  refused: 0,
  challenged: 0,
  unavailable: 0,
  busy: 0,
  failed: 0,
  capped: 0,
});

let stats = emptyStats();
/** When each of the last minute's asks went out. */
let sent: number[] = [];
let now: () => number = Date.now;

/** Test hook. */
export function resetPumpRelay(clock: () => number = Date.now): void {
  stats = emptyStats();
  sent = [];
  now = clock;
}

/** The counts since the last call, for the scan's heartbeat. */
export function takePumpRelayStats(): PumpRelayStats {
  const out = stats;
  stats = emptyStats();
  return out;
}

type RelayEnv = Pick<
  Env,
  "TOKENSAGE_ENABLED" | "TOKENSAGE_API_URL" | "TOKENSAGE_API_KEY" | "TOKENSAGE_TIMEOUT_MS"
>;

/**
 * The coin as TokenSage's relay read it from Pump.fun, or null when it didn't: TokenSage off, the
 * minute's asks spent, Pump.fun refusing or not knowing the coin, or TokenSage not answering.
 * Never throws.
 */
export async function relayCoin(
  mint: string,
  env: RelayEnv,
  client?: Pick<TokenSageClient, "pumpCoin">,
): Promise<DiscoveredCoin | null> {
  if (!tokenSageEnabled(env)) return null;
  const at = now();
  sent = sent.filter((t) => at - t < 60_000);
  if (sent.length >= MAX_PER_MIN) {
    stats.capped += 1;
    return null;
  }
  sent.push(at);
  stats.asked += 1;
  const api =
    client ??
    new TokenSageClient({
      baseUrl: env.TOKENSAGE_API_URL,
      apiKey: env.TOKENSAGE_API_KEY,
      timeoutMs: env.TOKENSAGE_TIMEOUT_MS,
    });
  try {
    const answer = await api.pumpCoin(mint);
    switch (answer.status) {
      case "ok":
        if (answer.coin?.mint === mint) {
          stats.ok += 1;
          return discoveredCoinFromRelay(answer.coin);
        }
        stats.notFound += 1;
        return null;
      case "not_found":
        stats.notFound += 1;
        return null;
      case "refused":
        stats.refused += 1;
        if (answer.cf_mitigated === "challenge") stats.challenged += 1;
        return null;
      case "busy":
        stats.busy += 1;
        return null;
      default:
        stats.unavailable += 1;
        return null;
    }
  } catch (err) {
    stats.failed += 1;
    logger.debug("TokenSage's Pump.fun relay didn't answer", { error: String(err) });
    return null;
  }
}
