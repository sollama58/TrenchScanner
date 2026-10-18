import { useEffect, useState } from "react";
import { graceLeftText, useProState } from "../proTrade";
import { InfoIcon } from "./Icons";

/**
 * The first of the grace period's warnings (user ask 2026-10-18), across the top of every page:
 * the wallet has dropped out of the top 250 $ASDFASDFA holders, and Pro Mode ends when the time
 * shown runs out unless it is back in by then. The Trade panel and its button in the token modal
 * say the same. Not dismissable: it is the one thing that stops a surprise.
 */
export function ProGraceBanner() {
  const pro = useProState();
  // Re-read each minute, so the time left counts down.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!pro?.graceEndsAt) return;
    const timer = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => clearInterval(timer);
  }, [pro?.graceEndsAt]);
  if (!pro?.pro || pro.graceEndsAt === null) return null;
  return (
    <aside className="announcement warning pro-grace" role="alert" aria-label="Pro Mode ending">
      <span className="announcement-icon" aria-hidden>
        <InfoIcon size={16} />
      </span>
      <p className="announcement-text">
        {pro.graceUnconfirmed
          ? "We can't confirm your place in the top 250 $ASDFASDFA holders right now. "
          : "Your wallet is no longer one of the top 250 $ASDFASDFA holders. "}
        Pro Mode ends in <strong className="num">{graceLeftText(pro.graceEndsAt)}</strong> unless{" "}
        {pro.graceUnconfirmed ? "it's confirmed" : "it's back in the top 250"} by then. After that you can't
        trade from the token window, sells included.
      </p>
    </aside>
  );
}
