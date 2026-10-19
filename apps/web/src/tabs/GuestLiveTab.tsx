import { SectionBoundary } from "../components/SectionBoundary";
import { Suspense, useMemo, useState } from "react";
import type { MatchPage } from "../api";
import { AlertCard } from "../components/AlertCard";
import { SkeletonCards } from "../components/Skeleton";
import { ScanStatus } from "../components/ScanStatus";
import { ClockIcon, InfoIcon, PaletteIcon, RadarIcon } from "../components/Icons";
import { prefetch } from "../cache";
import { usePolling, useNow } from "../hooks";
import { cardHideSet, feedGridProps, useAppearance } from "../appearance";
import { GUEST_DELAY_MINUTES } from "../session";
import { introSeen, markIntroSeen } from "../intro";
import { AboutModal, loadAboutModal, useOpenedOnce } from "../livePanels";

/** GET /guest/feed: the default feed's calls, as feed cards, plus which models those are. */
export interface GuestPage extends MatchPage {
  model: { id: string; name: string };
  /** Every model in the default feed, best first (absent from older API builds). */
  models?: { id: string; name: string }[];
  /** How long after each call guests see it (absent from API builds before the delay). */
  delayMinutes?: number;
}

/** The API serves guests this many pages; older history is for signed-in readers. */
const GUEST_MAX_PAGES = 5;

const TARGETS = { hitRate2xPct: 75, hitRate4xPct: 50 };

/**
 * The Live tab for a visitor without a wallet: the top models' calls from the read-only
 * guest endpoint, each one shown a few minutes after it was made (and said so, twice: in the
 * banner and on the feed itself). Everything that is saved to a wallet (model picks, the model-alerts switch,
 * feed stats, the look of the feed) shows greyed out with a prompt to connect one, and nothing
 * here calls a route that needs a session, so a guest sees no errors.
 */
export function GuestLiveTab({ onConnect }: { onConnect: () => void }) {
  const now = useNow(15_000);
  const [page, setPage] = useState(1);
  // The tour opens by itself the first time a guest lands here in this browser.
  const [aboutOpen, setAboutOpen] = useState(() => !introSeen(null));
  // The tour's code loads on its first opening (livePanels.ts), and it stays mounted after.
  const aboutMounted = useOpenedOnce(aboutOpen);
  const look = useAppearance();
  const hidden = useMemo(() => cardHideSet(look), [look]);
  const feedPath = (n: number) => `/guest/feed?page=${n}`;
  const feed = usePolling<GuestPage>(feedPath(page), 30_000);
  const data = feed.data;
  const hasMore = (data?.hasMore ?? false) && page < GUEST_MAX_PAGES;
  const models = data ? (data.models ?? [data.model]) : [];
  const modelName = models.length > 0 ? models.map((m) => m.name).join(", ") : "the top models";
  const many = models.length > 1;
  const delay = data?.delayMinutes ?? GUEST_DELAY_MINUTES;
  const lockTitle = "Connect a wallet to use this";

  return (
    <div className="stack">
      <Suspense fallback={null}>
        {aboutMounted && (
          <AboutModal
            open={aboutOpen}
            onClose={() => {
              setAboutOpen(false);
              markIntroSeen(null);
            }}
            targets={TARGETS}
            guest
          />
        )}
      </Suspense>
      <div className="guest-banner panel" role="note">
        <ClockIcon size={16} />
        <p>
          <strong>Guest mode: alerts are delayed {delay} minutes.</strong>{" "}
          {/* The same length before and after the feed lands (the heading below names the models),
              so the banner doesn't grow and push the feed down as it loads. */}
          <span className="muted">
            You see alerts from {data && !many ? "the default model" : "the top models by proven 2x rate"},{" "}
            {delay} minutes after they are made. Connect a wallet to get them live, plus your own filters,
            model picks, alerts and stats.
          </span>
        </p>
        <button className="button primary" onClick={onConnect}>
          Connect wallet
        </button>
      </div>
      <section className="panel feed">
        <header className="section-head">
          <div>
            <span className="eyebrow">Guest feed · {delay} min delay</span>
            <div className="heading-row">
              <h2>Alerts from {modelName}</h2>
              <button
                type="button"
                className="ghost icon-btn"
                onClick={() => setAboutOpen(true)}
                onPointerEnter={() => void loadAboutModal()}
                onFocus={() => void loadAboutModal()}
                aria-label="How this works"
                title="How this works"
              >
                <InfoIcon size={16} />
              </button>
            </div>
          </div>
          <div className="feed-controls">
            <button type="button" className="ghost stats-btn" disabled title={lockTitle}>
              <PaletteIcon size={14} />
              Customize
            </button>
            <span className="delay-pill" title={`Guests see each alert ${delay} minutes after it is made`}>
              <ClockIcon size={13} />
              Delayed {delay} min
            </span>
            <ScanStatus />
          </div>
        </header>
        {feed.error && !data && <p className="error">Couldn&apos;t load the feed: {feed.error.message}</p>}
        {!data && !feed.error && <SkeletonCards count={4} />}
        {data && data.matches.length === 0 && page === 1 && (
          <div className="empty-state">
            <RadarIcon size={28} />
            <p>
              Nothing from {modelName} yet. Alerts land here {delay} minutes after they are made.
            </p>
          </div>
        )}
        <div className={`cards${feed.stale ? " stale" : ""}`} aria-busy={feed.stale} {...feedGridProps(look)}>
          {data?.matches.map((card) => (
            <SectionBoundary key={card.id} label="This card" size="card" resetKey={card}>
              <AlertCard card={card} now={now} labelSource hide={hidden} />
            </SectionBoundary>
          ))}
        </div>
        {data && data.matches.length === 0 && page > 1 && (
          <p className="muted small center">Nothing older here.</p>
        )}
        {(page > 1 || hasMore) && (
          <nav className="pager">
            <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              ← Newer
            </button>
            <span className="muted small num">Page {page}</span>
            <button
              disabled={!hasMore || feed.stale}
              onPointerEnter={() => prefetch(feedPath(page + 1))}
              onFocus={() => prefetch(feedPath(page + 1))}
              onClick={() => setPage((p) => p + 1)}
            >
              Older →
            </button>
          </nav>
        )}
        {page >= GUEST_MAX_PAGES && (
          <p className="muted small center">Connect a wallet to see older alerts.</p>
        )}
      </section>
    </div>
  );
}
