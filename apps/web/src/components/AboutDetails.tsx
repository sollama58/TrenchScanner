import { BrainIcon, SlidersIcon } from "./Icons";

type Targets = { hitRate2xPct: number; hitRate4xPct: number };

/** The page's sections, in order, for the jump links at the top. */
const SECTIONS = [
  { id: "fp-goal", label: "The goal" },
  { id: "fp-scan", label: "Scan & safety" },
  { id: "fp-alerts", label: "Alerts" },
  { id: "fp-models", label: "Models" },
  { id: "fp-grading", label: "Grading" },
  { id: "fp-card", label: "Card terms" },
  { id: "fp-weather", label: "Weather" },
] as const;

/**
 * The fine print behind the Live tab's picture tour (AboutModal): every check, grade and card
 * figure in full, laid out to scan. Kept in step with how the scanner, models and grading actually
 * behave; the numbers come from packages/core (rugScreen.ts, config/env.ts, leaderboard.ts) and
 * apps/api/src/marketWeather.ts.
 */
export function AboutDetails({ targets }: { targets: Targets }) {
  return (
    <div className="fine-print">
      <nav className="fp-jump" aria-label="Jump to">
        {SECTIONS.map((s) => (
          <a
            key={s.id}
            href={`#${s.id}`}
            onClick={(e) => {
              // In-page jump inside the dialog, without touching the app's hash routes.
              e.preventDefault();
              document.getElementById(s.id)?.scrollIntoView({ behavior: "smooth", block: "start" });
            }}
          >
            {s.label}
          </a>
        ))}
      </nav>

      <section id="fp-goal">
        <h3>The goal</h3>
        <p>
          TrenchScanner watches new Pump.fun launches on Solana and flags the few worth a manual look. It
          finds tokens for you to inspect and trade yourself. It never trades, and nothing here is financial
          advice.
        </p>
        <div className="fp-targets">
          <div>
            <span className="num">{targets.hitRate2xPct}%</span>
            <span>double (2x) within 15 min</span>
          </div>
          <div>
            <span className="num">{targets.hitRate4xPct}%</span>
            <span>reach 4x within 30 min</span>
          </div>
          <div>
            <span className="num">25%</span>
            <span>reach 10x within 1 hour</span>
          </div>
        </div>
        <p className="fp-note">Targets for the share of alerts that hit each mark.</p>
      </section>

      <section id="fp-scan">
        <h3>The scan and the safety screen</h3>
        <p>
          New launches stream in as they happen. Every token in the market-cap band is rescanned about every
          30 seconds for market cap, liquidity, volume, holders, top-10 share, RugCheck risk and live trade
          flow (buyers, snipers, bundles, whether the dev sold). Before anything can alert, it must pass every
          rule below. A token that fails is dropped before your filters or the models see it.
        </p>
        <table className="fp-table">
          <thead>
            <tr>
              <th scope="col">Rule</th>
              <th scope="col">Rejected when</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Mint authority</td>
              <td>Not revoked (more supply could be printed)</td>
            </tr>
            <tr>
              <td>Freeze authority</td>
              <td>Not revoked (holders could be frozen)</td>
            </tr>
            <tr>
              <td>Primary LP</td>
              <td>Not burned or locked (the pool could be pulled)</td>
            </tr>
            <tr>
              <td>Mayhem Mode</td>
              <td>The launch used it</td>
            </tr>
            <tr>
              <td>Fresh top-10 wallets</td>
              <td>Over 70%</td>
            </tr>
            <tr>
              <td>Empty top-10 wallets</td>
              <td>80% or more</td>
            </tr>
            <tr>
              <td>Top-10 snipers</td>
              <td>80% or more</td>
            </tr>
            <tr>
              <td>Top-10 holders&apos; share of supply</td>
              <td>50% or more (pool aside)</td>
            </tr>
          </tbody>
        </table>
        <p>
          The three wallet checks cost a paid lookup per wallet, so they are rationed: tokens closest to
          alerting go first, then tokens already alerted on, then the rest as room allows. Until a check has
          run, the card says &ldquo;Not checked&rdquo;. That means not looked at yet, not clean.
        </p>
      </section>

      <section id="fp-alerts">
        <h3>Two kinds of alert</h3>
        <div className="fp-pair">
          <div>
            <span className="pill pill-mine">
              <SlidersIcon size={12} /> Your alert
            </span>
            <p>
              A token that matches your own filter from the Filters tab. Filters are checked every 15 seconds,
              and a match fires straight away, with two exceptions:
            </p>
            <ul className="fp-list">
              <li>It&apos;s held while the price is down 25% or more over the last 5 minutes.</li>
              <li>
                If your filter caps a wallet figure (Max fresh, Max empty or Max top-10 snipers), it waits for
                that figure, up to about 3 minutes, then alerts with it unknown.
              </li>
            </ul>
          </div>
          <div>
            <span className="pill pill-model">
              <BrainIcon size={12} /> Model
            </span>
            <p>
              A call from a model you follow, with its name and confidence (0 to 100). If several models call
              the same token, it shows once with all of them. Each model calls a token at most once a day.
            </p>
          </div>
        </div>
      </section>

      <section id="fp-models">
        <h3>How the models work</h3>
        <ol className="fp-steps">
          <li>
            <b>Train.</b> Every few hours each model retrains on recent graded history.
          </li>
          <li>
            <b>Exam.</b> It&apos;s tested on later weeks it never saw, and sets its cutoff: the loosest one
            that met the targets there, or its best slice if none did. It only calls tokens above that cutoff.
          </li>
          <li>
            <b>Rank.</b> Live calls are graded and scored 0 to 100 on the Models tab. 100 means the record
            meets the 2x, 4x and 10x targets and the run-size target (how far calls run over the next day). A
            few phantom misses are counted first, so a short lucky streak can&apos;t beat a long good record.
          </li>
          <li>
            <b>Evolve.</b> New variants are bred from the leaders. One that beats the weakest model takes its
            seat. Consensus learns which models to trust, and when.
          </li>
        </ol>
        <p>
          The top of the leaderboard is the default feed, re-picked after every run. Follow it automatically
          or keep your own picks in Settings.
        </p>
      </section>

      <section id="fp-grading">
        <h3>How alerts are graded</h3>
        <p>
          Every alert, yours and the models&apos;, is graded the same way, from the price at the moment it
          alerted. Winners are watched for a day after, so Peak shows how far they really ran.
        </p>
        <dl className="about-terms">
          <dt>◷ Pending</dt>
          <dd>Still inside its first 15 minutes.</dd>
          <dt className="fp-good">✓ 2x win</dt>
          <dd>Doubled within 15 minutes.</dd>
          <dt className="fp-good">✓✓ 4x win</dt>
          <dd>Also reached 4x within 30 minutes.</dd>
          <dt className="fp-good">✓✓✓ 10x win</dt>
          <dd>Also reached 10x within an hour.</dd>
          <dt className="fp-bad">✕ Missed 2x</dt>
          <dd>The 15 minutes ran out before it doubled.</dd>
          <dt className="fp-bad">✕ Stopped out</dt>
          <dd>Fell 50% below the alert price before doubling. Counts as a loss.</dd>
          <dt>Grading</dt>
          <dd>The window has closed and the result is being worked out.</dd>
        </dl>
      </section>

      <section id="fp-card">
        <h3>Card terms</h3>
        <dl className="about-terms">
          <dt>Alert · Now · Peak</dt>
          <dd>
            Market cap at the alert, right now (refreshed every few seconds while the page is open), and the
            best multiple since.
          </dd>
          <dt>Vol 24h · Holders · Age</dt>
          <dd>24-hour volume, holder count and minutes since launch, at alert time.</dd>
          <dt>Top 10</dt>
          <dd>Share of supply held by the 10 largest wallets.</dd>
          <dt>Fresh</dt>
          <dd>Share of the top 10 on wallets first used in the last 24 hours.</dd>
          <dt>Empty</dt>
          <dd>
            Share of the top 10 holding under $25 in other tokens (cash and SOL aside). Fresh and empty
            wallets are common signs of snipers or insiders. &ldquo;–&rdquo; means that one hasn&apos;t run
            yet.
          </dd>
          <dt>Snipers</dt>
          <dd>
            Of the first 25 buyers after launch (dev aside), how many still hold, as 12/25. Ones still holding
            can dump on you. Read once from the launch on chain, then rechecked every few minutes.
          </dd>
          <dt>Top-10 snipers</dt>
          <dd>
            Share of the top 10 holders (pool aside) that were among those first 25 buyers. 80% or more is
            always rejected.
          </dd>
          <dt>DH · DS</dt>
          <dd>Dev Holding: the creator still holds the token. Dev Sold: they hold none.</dd>
          <dt>Narrative: agrees · warns</dt>
          <dd>
            On other models&apos; calls: whether the Narrative model&apos;s read of the coin&apos;s story
            would have called it too. Toggle it in Customize. Until you do, it turns on by itself once the
            Narrative model doubles over 40% of its calls across 7 days.
          </dd>
          <dt>High conviction</dt>
          <dd>
            From the model&apos;s top half-percent most confident moments. Tracked separately on Models.
          </dd>
          <dt>≈41% 2x</dt>
          <dd>
            Of the model&apos;s recent calls ranked like this one, on data it wasn&apos;t trained on, the
            share that doubled within 15 minutes. With several models, the best of their rates.
          </dd>
        </dl>
        <p className="fp-note">
          Snipers, Top-10 snipers, Fresh and Empty can all be capped on the Filters tab, and the models read
          them too.
        </p>
      </section>

      <section id="fp-weather">
        <h3>Market weather</h3>
        <p>
          The gauge at the top of the Lighthouse (the button beside Stats, and the Lighthouse tab) compares
          two numbers: the share of graded launch moments that doubled within 15 minutes over the last 6
          hours, and the same share over the last 7 days.
        </p>
        <div className="fp-weather">
          <span className="cold">Cold · 25%+ below the week</span>
          <span className="normal">Normal · in between</span>
          <span className="hot">Hot · 25%+ above the week</span>
        </div>
        <p>
          With too few graded moments it says so instead of guessing. It&apos;s there to help you size or skip
          trades. It never changes or holds back an alert, and the models already factor the same reading in.
        </p>
      </section>

      <section>
        <h3>Staying current</h3>
        <p>
          New alerts arrive the moment they fire while the dot by the feed says Live, and every 30 seconds
          otherwise. The Model alerts switch and the model picker choose whose calls you see. Your own alerts
          always show.
        </p>
      </section>
    </div>
  );
}
