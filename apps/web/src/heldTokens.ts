import { useMemo } from "react";
import { usePollingAll } from "./hooks";
import { useProState, useTradeSettings } from "./proTrade";

/** GET /portfolio/held (apps/api/src/routes/portfolio.ts): the tracked coins the wallet holds. */
interface HeldTokens {
  tokenIds: string[];
  readAt: string | null;
}

/** The API reads the chain at most every 5 minutes; the Trade panel's own trades count at once. */
const HELD_POLL_MS = 30_000;

const NONE: ReadonlySet<string> = new Set();

/**
 * The token ids of the coins the signed-in Pro wallet holds, when its "Always show coins you hold"
 * setting is on (user ask 2026-10-19), else none. A held coin's card skips the viewer's own
 * filters on Cards and Scope (hidden tokens, the market cap line, Scope's column filters) but
 * keeps its place: it only shows where the feed or a column already carries it, and Scope's
 * "older than" cutoff still applies. Nothing is read for a wallet without Pro Mode.
 */
export function useHeldTokenIds(): ReadonlySet<string> {
  const pro = useProState();
  const settings = useTradeSettings();
  const on = (pro?.pro ?? false) && settings.alwaysShowHeld;
  const { data } = usePollingAll<HeldTokens>(on ? ["/portfolio/held"] : [], HELD_POLL_MS);
  const ids = on ? data[0]?.tokenIds : undefined;
  return useMemo(() => (ids && ids.length > 0 ? new Set(ids) : NONE), [ids]);
}
