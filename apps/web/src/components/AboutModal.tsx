import { useEffect, useRef, useState } from "react";
import { AboutDetails } from "./AboutDetails";
import { BrainIcon, CloseIcon, SlidersIcon } from "./Icons";
import { BouncerArt, CompeteArt, FunnelArt, GradeArt, GuestArt, TwoWaysArt, WeatherArt } from "./TourArt";
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
      onClose={onClose}
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
            <li>Top holders aren&apos;t mostly brand-new wallets</li>
            <li>Top holders aren&apos;t mostly empty wallets</li>
            <li>Early snipers don&apos;t own most of the top bags</li>
          </ul>
        </>
      ),
    },
    {
      title: "Two ways onto your feed",
      art: <TwoWaysArt />,
      body: (
        <div className="tour-pair">
          <div>
            <span className="pill pill-mine">
              <SlidersIcon size={12} /> Your alert
            </span>
            <p>
              A coin that matches the rules you set on the Filters tab. If a rule needs a wallet check, it
              waits for that check before it pings you.
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
      ),
    },
    {
      title: "The robots compete",
      art: <CompeteArt />,
      body: (
        <>
          <p className="tour-lead">
            Every few hours each model studies the latest coins, then sits a test on weeks it has never seen.
            The one closest to the goal leads and becomes your default feed. New models are bred from the
            winners, and a newcomer that beats the weakest takes its seat.
          </p>
        </>
      ),
    },
    {
      title: "Every alert gets a report card",
      art: <GradeArt />,
      body: (
        <>
          <p className="tour-lead">
            We start the clock at the price when it alerted. Doubling within 15 minutes is a win{" "}
            <b className="good">✓</b>. Reaching 4x within 30 minutes is <b className="good">✓✓</b>, and 10x
            within an hour is <b className="good">✓✓✓</b>. If it halves first, it&apos;s stopped out{" "}
            <b className="bad">✕</b>.
          </p>
          <div className="tour-goal">
            <span className="num">{t.hitRate2xPct}%</span>
            <span>
              The goal: {t.hitRate2xPct}% of alerts double, and {t.hitRate4xPct}% reach 4x.
            </span>
          </div>
        </>
      ),
    },
    {
      title: "Reading a card",
      art: <CardMock />,
      body: (
        <ol className="tour-legend">
          <li>Who called it: your filter, or a model and how sure it is.</li>
          <li>Market cap when it alerted, right now, and the best it has reached.</li>
          <li>
            Who holds it: the biggest 10 wallets&apos; share, and how many are brand-new or empty. Lower is
            usually safer.
          </li>
          <li>
            Snipers: of the first 25 buyers, how many still hold. DS means the creator sold, DH means they
            still hold.
          </li>
          <li>The grade so far.</li>
        </ol>
      ),
    },
    {
      title: "Check the weather in the Lighthouse",
      art: <WeatherArt />,
      body: (
        <>
          <p className="tour-lead">
            The Lighthouse button sits beside Stats on your feed. It&apos;s a quick look at the whole market,
            not just your alerts: how every coin that got past the bouncer did, and which stories (narratives)
            new coins are riding.
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
                  You see the leading model&apos;s calls {GUEST_DELAY_MINUTES} minutes after it makes them.
                  Connect a wallet to get them live, plus your own filters, model picks, alerts and stats.
                </p>
                <p className="tour-note">Tap the ⓘ by the feed title to see this tour again.</p>
              </>
            ),
          },
        ]
      : []),
  ];
}

/** A pretend alert card with numbered spots, for the "Reading a card" page. */
function CardMock() {
  return (
    <div className="tour-card" role="img" aria-label="An example alert card with five numbered parts">
      <div className="tour-card-head">
        <span className="tour-card-name">
          <span className="tour-card-logo" aria-hidden />
          <b>FROGGO</b>
        </span>
        <span className="tour-card-pills">
          <span className="pill pill-model">
            <BrainIcon size={11} /> Model · 82
          </span>
          <Spot n={1} />
        </span>
      </div>
      <div className="tour-card-stats">
        <div>
          <span className="faint">Alert</span>
          <b className="num">$14k</b>
        </div>
        <div>
          <span className="faint">Now</span>
          <b className="num">$33k</b>
        </div>
        <div>
          <span className="faint">Peak</span>
          <b className="num good">2.6x</b>
        </div>
        <Spot n={2} />
      </div>
      <div className="tour-card-chips">
        <span className="pill">Top 10 · 19%</span>
        <span className="pill">Fresh · 10%</span>
        <span className="pill">Empty · 20%</span>
        <Spot n={3} />
      </div>
      <div className="tour-card-chips">
        <span className="pill">Snipers · 4/25</span>
        <span className="pill">DS</span>
        <Spot n={4} />
        <span className="tour-card-grade">
          <span className="pill tour-win">✓ 2x win</span>
          <Spot n={5} />
        </span>
      </div>
    </div>
  );
}

function Spot({ n }: { n: number }) {
  return (
    <span className="tour-spot num" aria-hidden>
      {n}
    </span>
  );
}
