import { feeDesksFromOtcRoster, type OtcDeskFee } from "./feeDesks.js";

/**
 * OTC Desks' public launch roster (user ask 2026-10-21). One GET of the active list, not a
 * page-by-page pull of the full history: that history is thousands of coins and was not
 * checked from here. A failed or empty read shows nothing. The test runner does not call
 * the host; fetchOtcDeskRoster is what the tests drive.
 */
const OTC_COINS_URL = "https://otcdesks.cash/api/coins";
const FRESH_MS = 5 * 60_000;
const FAILURE_MS = 60_000;

let cached: { at: number; fees: Map<string, OtcDeskFee> } | null = null;
let inflight: Promise<Map<string, OtcDeskFee>> | null = null;

export async function fetchOtcDeskRoster(
  fetchImpl: typeof fetch = fetch,
  url = OTC_COINS_URL,
): Promise<Map<string, OtcDeskFee>> {
  const res = await fetchImpl(url, {
    signal: AbortSignal.timeout(2_500),
    headers: { accept: "application/json" },
  });
  if (!res.ok) return new Map();
  return feeDesksFromOtcRoster(await res.json());
}

function freshEnough(): boolean {
  if (!cached) return false;
  const age = Date.now() - cached.at;
  return cached.fees.size > 0 ? age < FRESH_MS : age < FAILURE_MS;
}

async function refresh(): Promise<Map<string, OtcDeskFee>> {
  try {
    const fees = await fetchOtcDeskRoster();
    cached = { at: Date.now(), fees };
    return fees;
  } catch {
    cached = { at: Date.now(), fees: cached?.fees ?? new Map() };
    return cached.fees;
  }
}

/**
 * Reward coins for these mints. `wait` holds for the roster (the token page).
 * The feed does not: it uses whatever is already cached and refreshes behind the request,
 * so a cold roster does not stall every card.
 */
export async function otcDeskFees(
  mints: readonly string[],
  opts?: { wait?: boolean },
): Promise<Map<string, OtcDeskFee>> {
  if (process.env.VITEST === "true" || mints.length === 0) return new Map();
  if (!freshEnough()) {
    if (opts?.wait) {
      inflight ??= refresh().finally(() => {
        inflight = null;
      });
      await inflight;
    } else if (!inflight) {
      inflight = refresh().finally(() => {
        inflight = null;
      });
    }
  }
  const fees = cached?.fees;
  if (!fees || fees.size === 0) return new Map();
  const out = new Map<string, OtcDeskFee>();
  for (const mint of mints) {
    const fee = fees.get(mint);
    if (fee) out.set(mint, fee);
  }
  return out;
}
