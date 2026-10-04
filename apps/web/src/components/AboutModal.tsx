import { useEffect, useRef } from "react";
import { BrainIcon, CloseIcon, SlidersIcon } from "./Icons";

/**
 * The Live tab's "how this works" page, in a native modal dialog (Escape, focus and the backdrop
 * come with it). Kept in step with how the scanner, models and grading actually behave.
 */
export function AboutModal({
  open,
  onClose,
  targets,
}: {
  open: boolean;
  onClose: () => void;
  targets: { hitRate2xPct: number; hitRate4xPct: number };
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="about-modal"
      aria-labelledby="about-title"
      onClose={onClose}
      // A click on the backdrop lands on the dialog element itself; clicks inside land on its content.
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="about-body">
        <header className="about-head">
          <h2 id="about-title">How TrenchScanner works</h2>
          <button className="ghost icon-btn" onClick={onClose} aria-label="Close">
            <CloseIcon size={16} />
          </button>
        </header>

        <p>
          TrenchScanner watches new Pump.fun launches on Solana and flags the few worth a manual look. The aim
          is that {targets.hitRate2xPct}% of alerts double and {targets.hitRate4xPct}% reach 4x within an
          hour. It finds tokens for you to inspect and trade yourself; it doesn&apos;t trade, and nothing here
          is financial advice.
        </p>

        <h3>The scan</h3>
        <p>
          New launches stream in as they happen, and every token in the market-cap band is rescanned about
          once a minute: market cap, liquidity, volume, holders, how much the top 10 wallets hold, RugCheck
          risk, and the live trade flow (who is buying, snipers, bundles, whether the dev sold). Tokens that
          fail the rug screen are dropped before anything else looks at them.
        </p>

        <h3>Two kinds of alert</h3>
        <ul>
          <li>
            <span className="pill pill-mine">
              <SlidersIcon size={12} /> Your alert
            </span>{" "}
            A token that passed your own filter, set on the Filters tab. It fires the moment a scan sees a
            match.
          </li>
          <li>
            <span className="pill pill-model">
              <BrainIcon size={12} /> Model
            </span>{" "}
            A call from a model you follow, with its name and confidence (0-100). When several models call the
            same token, it shows once with every model that called it.
          </li>
        </ul>

        <h3>The models</h3>
        <p>
          Several models compete, each reading the market differently. Every few hours they retrain on recent
          graded history and sit an exam on later weeks they never saw. Each one only calls its most confident
          slice: the loosest cutoff that met the targets in that exam, or its best slice when none did. Their
          live calls are graded and ranked on the Models tab, and every few hours new variants are bred from
          the leaders; one that beats the weakest model takes its seat. Consensus learns which models to trust
          and when they agree, and is the default feed. Model calls are paced, so a busy market doesn&apos;t
          flood the feed.
        </p>

        <h3>How alerts are graded</h3>
        <p>
          Every alert, yours and the models&apos;, is graded the same way. The entry is a realistic fill: the
          first price at least a minute after the alert, plus slippage. It&apos;s a win if it reaches 2x
          within 1 hour of the alert, and a 4x win if it gets there. If it drops 50% before doubling,
          it&apos;s stopped out and counts as a loss.
        </p>
        <dl className="about-terms">
          <dt>Live · 42m left</dt>
          <dd>Still inside its hour; the bar along the top of the card shows how much is gone.</dd>
          <dt>✓ 2x win, ✓✓ 4x win</dt>
          <dd>Reached the multiple within the hour.</dd>
          <dt>✕ Missed 2x</dt>
          <dd>The hour ran out before it doubled.</dd>
          <dt>✕ Stopped out</dt>
          <dd>Fell 50% from the fill before doubling.</dd>
          <dt>Grading</dt>
          <dd>The hour is over and the result is being worked out.</dd>
        </dl>

        <h3>Reading a card</h3>
        <dl className="about-terms">
          <dt>Alert, Now, Peak</dt>
          <dd>
            Market cap when it was alerted, now (refreshed every few seconds while the page is open), and the
            best multiple it has reached since.
          </dd>
          <dt>Liq, Vol 24h, Holders, Age</dt>
          <dd>Liquidity, 24-hour volume, holder count and minutes since launch, at alert time.</dd>
          <dt>Top 10</dt>
          <dd>Share of supply held by the 10 largest wallets.</dd>
          <dt>Fresh wallets</dt>
          <dd>
            How many of the top 10 holders are wallets first used in the last 24 hours, a common sign of
            snipers or insiders. Shown as &ldquo;–&rdquo; until those wallets have been looked up.
          </dd>
          <dt>Risk</dt>
          <dd>RugCheck&apos;s risk score, 0-100, lower is safer.</dd>
        </dl>

        <h3>Staying current</h3>
        <p>
          New alerts arrive the moment they fire while the dot by the feed says Live (it falls back to
          checking every 30 seconds otherwise). Use the Model alerts switch and the model picker to choose
          whose calls you see; your own alerts always show.
        </p>
      </div>
    </dialog>
  );
}
