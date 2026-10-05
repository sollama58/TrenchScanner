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
          every 30 seconds: market cap, liquidity, volume, holders, how much the top 10 wallets hold, RugCheck
          risk, and the live trade flow (who is buying, snipers, bundles, whether the dev sold). Before
          anything can alert, a token must pass the safety screen: mint and freeze authority renounced,
          liquidity burned or locked, not a Mayhem Mode launch, and no more than 70% of its top 10 holders on
          fresh wallets. Tokens that fail are dropped before your filters or the models see them.
        </p>
        <p>
          Every scanned token gets all of the checks above. Two checks on its top 10 holders are rationed: how
          many are fresh wallets, and how many are empty (under $25 of other tokens). Each one is a paid
          lookup per wallet, so the scanner checks a limited number of wallets per scan, starting with the
          tokens closest to alerting. The rest are checked as room allows. Until then a card shows &ldquo;Not
          checked&rdquo;, which means the check hasn&apos;t run yet, not that the wallets are clean.
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
          live calls are graded and ranked on the Models tab by one score: how far each model has proven
          itself toward the goal, 0 to 100, where 100 means its record meets both hit-rate targets. A few
          phantom misses are counted first, so a short streak can&apos;t outscore a long good record. Every
          few hours new variants are bred from the leaders; one that beats the weakest model takes its seat.
          Consensus learns which models to trust and when they agree. The best performer on the leaderboard is
          the default feed, re-chosen after every run; you can follow it automatically or keep your own picks
          in Settings. Model calls are paced, so a busy market doesn&apos;t flood the feed.
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
          <dt>Fresh / Empty</dt>
          <dd>
            Of the top 10 holders, the share on wallets first used in the last 24 hours, then the share
            holding under $25 of anything else. Both are common signs of snipers or insiders. Shows &ldquo;Not
            checked&rdquo; until those wallets have been looked up, and &ldquo;–&rdquo; for one of the two
            that hasn&apos;t run yet.
          </dd>
          <dt>Snipers</dt>
          <dd>
            Of the first 25 wallets to buy after launch (the dev aside), how many still hold it, shown as
            12/25. Snipers who have sold out can&apos;t dump on you; ones still holding can. The first buyers
            are read once from the token&apos;s launch transactions on chain and their wallets are rechecked
            every few minutes, so it shows &ldquo;–&rdquo; only until a new token has been checked. You can
            set a minimum or maximum on the Filters tab, and the models read it too.
          </dd>
          <dt>Dev</dt>
          <dd>
            DH (Dev Holding) means the creator&apos;s wallet still holds the token; DS (Dev Sold) means it
            holds none. Read from the live trade stream when the scanner saw the launch, otherwise from
            RugCheck, and kept current as the token is rescanned.
          </dd>
          <dt>Risk</dt>
          <dd>RugCheck&apos;s risk score, 0-100, lower is safer.</dd>
          <dt>High conviction</dt>
          <dd>
            The call came from the model&apos;s most confident moments (its top half-percent). These are rarer
            and the Models tab tracks their hit rate separately.
          </dd>
          <dt>≈41% 2x</dt>
          <dd>
            Of the model&apos;s recent calls ranked like this one, on data it wasn&apos;t trained on, the
            share that doubled within the hour. When several models called the token, the best of their rates.
          </dd>
        </dl>

        <h3>Market weather</h3>
        <p>
          The chip under the scores says how often launches are doubling right now. It takes every decision
          moment the scanner graded in the last 6 hours (tokens in the market-cap band, checked on the hour
          and when something happened) and counts the share that hit 2x within the hour. It compares that with
          the same share over the last 7 days: 25% or more above the week reads hot, 25% or more below reads
          cold, anything between is normal. With too few graded moments it says so instead of guessing.
        </p>
        <p>
          It is there to help you size or skip trades on a cold day. It doesn&apos;t change or hold back any
          alert; the models already take the same reading into account when they score a token.
        </p>

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
