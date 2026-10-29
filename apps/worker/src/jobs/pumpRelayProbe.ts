import { createLogger, tokenSageEnabled, TokenSageClient, type Env } from "@trenchscanner/core";

const logger = createLogger("pump-relay-probe");

/**
 * The test before routing Pump.fun reads through TokenSage (user decision 2026-10-29, check-in
 * that day). Pump.fun's Cloudflare has refused this service since 2026-10-22, Origin and
 * User-Agent included (#1128), while TokenSage in the same Render region is answered. When a
 * launch's Pump.fun read is refused, at most one coin a PROBE_EVERY_MS is asked of TokenSage's
 * relay (GET /v1/pumpfun/coins/{ca}), and the scan's heartbeat counts how it went. Nothing reads
 * the answer yet: `ok` while `pumpfunGate.refused` keeps rising says routing will hold.
 */
export const PROBE_EVERY_MS = 60_000;

export interface PumpRelayProbeStats {
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
}

const emptyStats = (): PumpRelayProbeStats => ({
  asked: 0,
  ok: 0,
  notFound: 0,
  refused: 0,
  challenged: 0,
  unavailable: 0,
  busy: 0,
  failed: 0,
});

let stats = emptyStats();
let lastAt = -Infinity;
let now: () => number = Date.now;

/** Test hook. */
export function resetPumpRelayProbe(clock: () => number = Date.now): void {
  stats = emptyStats();
  lastAt = -Infinity;
  now = clock;
}

/** The counts since the last call, for the scan's heartbeat. */
export function takePumpRelayProbeStats(): PumpRelayProbeStats {
  const out = stats;
  stats = emptyStats();
  return out;
}

type ProbeEnv = Pick<
  Env,
  "TOKENSAGE_ENABLED" | "TOKENSAGE_API_URL" | "TOKENSAGE_API_KEY" | "TOKENSAGE_TIMEOUT_MS"
>;

/**
 * Pump.fun refused this mint: ask TokenSage's relay for it, unless a probe went out less than
 * PROBE_EVERY_MS ago. Never throws; call without awaiting.
 */
export async function probePumpRelay(
  mint: string,
  env: ProbeEnv,
  client?: Pick<TokenSageClient, "pumpCoin">,
): Promise<void> {
  if (!tokenSageEnabled(env)) return;
  const at = now();
  if (at - lastAt < PROBE_EVERY_MS) return;
  lastAt = at;
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
        stats.ok += 1;
        break;
      case "not_found":
        stats.notFound += 1;
        break;
      case "refused":
        stats.refused += 1;
        if (answer.cf_mitigated === "challenge") stats.challenged += 1;
        break;
      case "busy":
        stats.busy += 1;
        break;
      default:
        stats.unavailable += 1;
    }
  } catch (err) {
    stats.failed += 1;
    logger.debug("TokenSage's Pump.fun relay didn't answer", { error: String(err) });
  }
}
