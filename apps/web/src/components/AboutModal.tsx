import { useEffect, useRef, useState } from "react";
import { AboutDetails } from "./AboutDetails";
import { BrainIcon, CloseIcon, SlidersIcon } from "./Icons";
import {
  BouncerArt,
  BubblesArt,
  FunnelArt,
  GuestArt,
  KolArt,
  TwoWaysArt,
  WeatherArt,
  YoursArt,
} from "./TourArt";
import { GUEST_DELAY_MINUTES } from "../session";

type Targets = { hitRate2xPct: number; hitRate4xPct: number };

/**
 * The Live tab's "how this works": a short picture tour in plain words, with the full fine print
 * one tap away (AboutDetails). A native modal dialog, so Escape, focus and the backdrop come with
 * it; the arrow keys page the tour. It opens by itself the first time a wallet (or a guest) lands
 * on the Live tab (see intro.ts) and from the info button by the feed heading after that.
 */
export function AboutModal({
  open,
  onClose,
  targets,
  guest = false,
}: {
  open: boolean;
  onClose: () => void;
  targets: Targets;
  guest?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [step, setStep] = useState(0);
  const [details, setDetails] = useState(false);
  const slides = tourSlides(targets, guest);
  const last = slides.length - 1;
  const at = Math.min(step, last);
  const slide = slides[at]!;

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      setStep(0);
      setDetails(false);
      dialog.showModal();
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);

  // Each page starts at its top.
  useEffect(() => {
    ref.current?.scrollTo?.({ top: 0 });
  }, [at, details]);

  const go = (n: number) => setStep(Math.max(0, Math.min(last, n)));

  return (
    <dialog
      ref={ref}
      className="about-modal tour-modal"
      aria-labelledby="about-title"
      onClose={(e) => {
        // Only this dialog's own close: a nested dialog's close bubbles up through React.
        if (e.target === e.currentTarget) onClose();
      }}
      // A click on the backdrop lands on the dialog element itself; clicks inside land on its content.
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => {
        if (details) return;
        if (e.key === "ArrowRight") go(at + 1);
        if (e.key === "ArrowLeft") go(at - 1);
      }}
    >
      <div className="about-body">
        <header className="about-head">
          <h2 id="about-title">{details ? "The fine print" : "How TrenchScanner works"}</h2>
          <button className="ghost icon-btn" onClick={onClose} aria-label="Close">
            <CloseIcon size={16} />
          </button>
        </header>

        {details ? (
          <>
            <button type="button" className="ghost tour-back-link" onClick={() => setDetails(false)}>
              ← Back to the picture tour
            </button>
            <AboutDetails targets={targets} />
          </>
        ) : (
          <>
            <div className="tour-slide" key={at} aria-live="polite">
              <div className="tour-art-wrap">{slide.art}</div>
              <span className="eyebrow tour-step num">
                {at + 1} of {slides.length}
              </span>
              <h3 className="tour-title">{slide.title}</h3>
              {slide.body}
            </div>
            <footer className="tour-foot">
              <div className="tour-dots" role="tablist" aria-label="Tour pages">
                {slides.map((s, i) => (
                  <button
                    key={s.title}
                    type="button"
                    role="tab"
                    aria-selected={i === at}
                    aria-label={`${i + 1}. ${s.title}`}
                    className={i === at ? "on" : ""}
                    onClick={() => go(i)}
                  />
                ))}
              </div>
              <button type="button" className="ghost tour-fine" onClick={() => setDetails(true)}>
                Fine print
              </button>
              <div className="tour-nav">
                <button type="button" className="ghost" disabled={at === 0} onClick={() => go(at - 1)}>
                  Back
                </button>
                {at < last ? (
                  <button type="button" className="button primary" onClick={() => go(at + 1)}>
                    Next
                  </button>
                ) : (
                  <button type="button" className="button primary" onClick={onClose}>
                    Let&apos;s go
                  </button>
                )}
              </div>
            </footer>
          </>
        )}
      </div>
    </dialog>
  );
}

interface Slide {
  title: string;
  art: React.ReactNode;
  body: React.ReactNode;
}

function tourSlides(t: Targets, guest: boolean): Slide[] {
  return [
    {
      title: "We find the few coins worth a look",
      art: <FunnelArt />,
      body: (
        <>
          <p className="tour-lead">
            Hundreds of new meme coins launch on Pump.fun every hour. Most go nowhere. TrenchScanner watches
            every single one and taps you on the shoulder for the handful that look ready to run.
          </p>
          <p className="tour-note">
            You decide and you trade. We never touch your money, and nothing here is financial advice.
          </p>
        </>
      ),
    },
    {
      title: "First, the bouncer",
      art: <BouncerArt />,
      body: (
        <>
          <p className="tour-lead">
            Every coin must pass a safety check before you or the models ever see it. Break one rule and
            it&apos;s out.
          </p>
          <ul className="tour-checks">
            <li>Mint Authority revoked</li>
            <li>Nobody can freeze your coins</li>
            <li>Primary LP Locked</li>
            <li>Not a Mayhem Mode launch</li>
            <li>Top holders aren&apos;t mostly fresh wallets (new, or woken after a week idle)</li>
            <li>Top holders aren&apos;t mostly empty wallets</li>
            <li>Early snipers don&apos;t own most of the top bags</li>
            <li>The top 10 holders own under 40% of the supply</li>
            <li>No single holder owns more than 10% of the supply</li>
            <li>Under 20 of the top 25 holders share a funder or a funding minute</li>
            <li>Under 21 of the top 25 holders were funded from an exchange</li>
            <li>The bonding curve wasn&apos;t bought out within 5 seconds of launch</li>
          </ul>
        </>
      ),
    },
    {
      title: "Two ways onto your feed",
      art: <TwoWaysArt />,
      body: (
        <>
          <div className="tour-pair">
            <div>
              <span className="pill pill-mine">
                <SlidersIcon size={12} /> Your alert
              </span>
              <p>
                A coin that matches one of the filters you&apos;ve switched on in the Filters tab. If a rule
                needs a wallet check, it waits for that check before it pings you.
              </p>
            </div>
            <div>
              <span className="pill pill-model">
                <BrainIcon size={12} /> Model
              </span>
              <p>
                A robot that studied thousands of past coins says &ldquo;this one!&rdquo;, with how sure it is
                from 0 to 100.
              </p>
            </div>
          </div>
          <div className="tour-goal">
            <ul className="tour-tiers" aria-label="How alerts are graded">
              <li>
                <b className="good">✓</b>
                <b className="tier-x num">2x</b>
                <span>in 15 min</span>
              </li>
              <li>
                <b className="good">✓✓</b>
                <b className="tier-x num">4x</b>
                <span>in 30 min</span>
              </li>
              <li>
                <b className="good">✓✓✓</b>
                <b className="tier-x num">10x</b>
                <span>in 1 hour</span>
              </li>
            </ul>
            <p>
              Either way, every alert is graded from its price when it alerted. Our goal:{" "}
              <b>{t.hitRate2xPct}%</b> of alerts double, <b>{t.hitRate4xPct}%</b> reach 4x, and the models
              catch <b>75%</b> of all the coins that double.
            </p>
          </div>
        </>
      ),
    },
    {
      title: "See who really holds the coin",
      art: <BubblesArt />,
      body: (
        <>
          <p className="tour-lead">
            Top holders can look spread out when one person is behind several of them. For each top-25 wallet
            we look up who paid for it, and wallets with the same funder count as one buyer.
          </p>
          <ul className="tour-keys">
            <li>
              <b>The Linked tile</b> on each card counts the top 25 that share a funder or a funding minute,
              as 13/25, and turns red at 20/25. Open the coin for its bubble map, where Linked also gives the
              supply they hold: <span className="num">13/25 (16.2%)</span>.
            </li>
            <li>
              <b>On the map</b>, each bubble is a holder, sized and labelled with its share down to 0.1%. One
              colour means one funder, a red ring marks a risky wallet or known dumper, and a dotted ring
              means funded within the same minute. A coin a model alerted on also brings in known wallets from
              its top 50.
            </li>
            <li>
              <b>Under the map</b>, tap a cluster, KOL, exchange or funding minute to list its wallets with
              their shares. Any wallet opens its own page, with a Search X button to see who&apos;s talking
              about it.
            </li>
          </ul>
          {guest && <p className="tour-note">The bubble map comes with a connected wallet.</p>}
        </>
      ),
    },
    {
      title: "Know when a KOL is in",
      art: <KolArt />,
      body: (
        <>
          <p className="tour-lead">
            KOLs (the traders people follow) show in gold on the map, gathered with every wallet tied to them,
            and the share of supply they may control together.
          </p>
          <ul className="tour-keys">
            <li>
              <b>Known Side</b>: another wallet we know is the same KOL&apos;s.
            </li>
            <li>
              <b>KOL Funded</b>: a wallet the KOL paid for.
            </li>
            <li>
              <b>Probable side</b> (a dotted gold line, &ldquo;side?&rdquo;): a wallet that keeps buying the
              KOL&apos;s coins within minutes of it. Probable, not confirmed.
            </li>
            <li>
              <b>Same funder or same minute</b>: a holder funded alongside any of those.
            </li>
          </ul>
          <p className="tour-note">
            That share is the card&apos;s KOL bundled figure too. Add it as a tile from Customize, or cap it
            in a filter.
          </p>
        </>
      ),
    },
    ...(guest
      ? []
      : [
          {
            title: "Make the feed yours",
            art: <YoursArt />,
            body: (
              <ul className="tour-keys">
                <li>
                  <b>Filters</b>: keep up to ten and switch each one on or off by itself. Several can alert at
                  once, and a paused one keeps its settings.
                </li>
                <li>
                  <b>Customize</b>, beside the feed: hide alerts whose market cap has fallen below a line you
                  set, and pick which tiles each card shows.
                </li>
                <li>
                  <b>Telegram</b>: send alerts from the Live feed&apos;s models, or pick a different set just
                  for Telegram on the Filters tab.
                </li>
                <li>
                  <b>Updates</b>: when we ship a new version, a banner offers a one-tap reload.
                </li>
              </ul>
            ),
          },
        ]),
    {
      title: "Check the weather in the Lighthouse",
      art: <WeatherArt />,
      body: (
        <>
          <p className="tour-lead">
            The Lighthouse has its own tab, next to Models. It&apos;s a look at the whole market, not just
            your alerts: how every coin that got past the bouncer did, and which stories (narratives) new
            coins are riding.
          </p>
          <p className="tour-lead">
            Its weather gauge, up top, says whether coins are doubling more or less often right now than over
            the past week. Size up on a hot day, sit out a cold one. It never hides an alert.
          </p>
          {!guest && <p className="tour-note">Tap the ⓘ by the feed title to see this tour again.</p>}
        </>
      ),
    },
    ...(guest
      ? [
          {
            title: "You're looking around as a guest",
            art: <GuestArt delay={GUEST_DELAY_MINUTES} />,
            body: (
              <>
                <p className="tour-lead">
                  You see the top models&apos; alerts {GUEST_DELAY_MINUTES} minutes after they raise them.
                  Connect a wallet to get them live, plus your own filters, model selection, alerts and stats,
                  the bubble map and the free Side Wallet Checker.
                </p>
                <p className="tour-note">Tap the ⓘ by the feed title to see this tour again.</p>
              </>
            ),
          },
        ]
      : []),
  ];
}
